import { AbstractInputSuggest, App, debounce, Scope, setIcon } from "obsidian";
import type ChatNotesPlugin from "./main";
import { searchSuggestions, SearchSuggestion, SuggestionValues } from "./search";

/* How long typing has to pause before the filter runs. Filtering hides and shows rows across
   the whole note, so running it for every key while a term is still being typed is wasted
   work; Enter skips the wait. */
const SEARCH_DELAY_MS = 200;

/* The filter names and values offered while typing. The popover pushes its own scope while it
   is open, above the field's, so Enter and Escape pick and close here before they search or
   close the bar. */
class SearchFilterSuggest extends AbstractInputSuggest<SearchSuggestion> {
	constructor(app: App, private fieldEl: HTMLInputElement, private getValues: () => Promise<SuggestionValues>) {
		super(app, fieldEl);
	}

	protected async getSuggestions(query: string): Promise<SearchSuggestion[]> {
		const values = await this.getValues();
		return searchSuggestions(query, this.fieldEl.selectionStart ?? query.length, values);
	}

	renderSuggestion(suggestion: SearchSuggestion, el: HTMLElement) {
		el.addClass("chat-search-suggestion");
		el.createSpan({ cls: "chat-search-suggestion-label", text: suggestion.label });
		if (suggestion.hint) el.createSpan({ cls: "chat-search-suggestion-hint", text: suggestion.hint });
	}
}

/* The search bar floating over the top of a chat note. Like the chat input there is one of
   them, moved between views on file switch (see ChatNotesPlugin.syncSearchBar), and it acts
   on the file it is mounted for. */
export function createSearchBar(plugin: ChatNotesPlugin) {
	const container = createDiv("chat-search-bar");

	const icon = container.createSpan("chat-search-icon");
	setIcon(icon, "search");

	const input = container.createEl("input", { cls: "chat-search-input" });
	input.type = "text";
	input.placeholder = "Search messages, or filter with author:, after: …";
	input.setAttribute("aria-label", "Search messages");
	input.spellcheck = false;

	// shown when a filter's value couldn't be read, with the reason as its tooltip
	const warning = container.createSpan("chat-search-warning");
	setIcon(warning, "alert-triangle");

	const count = container.createSpan("chat-search-count");

	const emojiBtn = container.createEl("button", { cls: "chat-search-emoji-btn" });
	emojiBtn.type = "button";
	emojiBtn.setAttribute("aria-label", "Insert emoji");
	setIcon(emojiBtn, "smile");
	emojiBtn.addEventListener("click", (e) => {
		// or the document handler that closes message menus would close the picker with them
		e.stopPropagation();
		plugin.toggleSearchEmojiPicker(emojiBtn);
	});

	const closeBtn = container.createEl("button", { cls: "chat-search-close-btn" });
	closeBtn.type = "button";
	closeBtn.setAttribute("aria-label", "Close search");
	setIcon(closeBtn, "x");
	closeBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		plugin.closeSearch();
	});

	// reset on every key, so it only fires once the typing pauses
	const apply = debounce(() => plugin.setSearchQuery(input.value), SEARCH_DELAY_MS, true);
	input.addEventListener("input", () => apply());

	/* Pushed while the field has focus, as the chat input does: Obsidian's global keymap
	   would otherwise get Escape first. Tracked so teardown can pop it - a focused element
	   removed from the DOM fires no blur.

	   Must be registered before the suggest below: it reopens its popover on focus and pushes
	   its own scope for the arrow keys and Enter, and focus listeners run in the order they were
	   added. The other way round, this scope lands on top and the popover gets no keys. */
	const scope = new Scope(plugin.app.scope);
	let pushed = false;

	scope.register([], "Enter", () => {
		apply.run();
		return false;
	});
	scope.register([], "Escape", () => {
		plugin.closeSearch();
		return false;
	});

	input.addEventListener("focus", () => {
		if (pushed) return;
		pushed = true;
		plugin.app.keymap.pushScope(scope);
	});
	input.addEventListener("blur", () => {
		if (!pushed) return;
		pushed = false;
		plugin.app.keymap.popScope(scope);
	});

	const suggest = new SearchFilterSuggest(plugin.app, input, () => plugin.getSearchSuggestionValues());
	suggest.onSelect((suggestion) => {
		const value = input.value;
		input.value = value.slice(0, suggestion.from) + suggestion.insert + value.slice(suggestion.to);
		const caret = suggestion.from + suggestion.insert.length;
		input.setSelectionRange(caret, caret);

		/* Searches the new text and asks for the next suggestions: after a filter name, its
		   values. A microtask, so it runs after the popover has finished closing itself. */
		queueMicrotask(() => input.dispatchEvent(new Event("input")));
	});

	// types `text` at the caret, over any selection, and searches it the way typing would
	const insertAtCaret = (text: string) => {
		input.focus();
		const start = input.selectionStart ?? input.value.length;
		input.setRangeText(text, start, input.selectionEnd ?? start, "end");
		input.dispatchEvent(new Event("input"));
	};

	const teardown = () => {
		apply.cancel();
		suggest.close();
		if (pushed) plugin.app.keymap.popScope(scope);
		pushed = false;
	};

	return {
		container,
		input,
		count,
		warning,
		// applies a pending query now - before the bar moves on, so it lands on the file it was typed for
		flushPending: () => { apply.run(); },
		cancelPending: () => { apply.cancel(); },
		insertAtCaret,
		teardown
	};
}
