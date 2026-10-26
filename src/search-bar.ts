import { debounce, Scope, setIcon } from "obsidian";
import type ChatNotesPlugin from "./main";

/* How long typing has to pause before the filter runs. Filtering hides and shows rows across
   the whole note, so running it for every key while a term is still being typed is wasted
   work; Enter skips the wait. */
const SEARCH_DELAY_MS = 200;

/* The search bar floating over the top of a chat note. Like the chat input there is one of
   them, moved between views on file switch (see ChatNotesPlugin.syncSearchBar), and it acts
   on the file it is mounted for. */
export function createSearchBar(plugin: ChatNotesPlugin) {
	const container = createDiv("chat-search-bar");

	const icon = container.createSpan("chat-search-icon");
	setIcon(icon, "search");

	const input = container.createEl("input", { cls: "chat-search-input" });
	input.type = "text";
	input.placeholder = "Search messages";
	input.setAttribute("aria-label", "Search messages");
	input.spellcheck = false;

	const count = container.createSpan("chat-search-count");

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
	   removed from the DOM fires no blur. */
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

	const teardown = () => {
		apply.cancel();
		if (pushed) plugin.app.keymap.popScope(scope);
		pushed = false;
	};

	return {
		container,
		input,
		count,
		// applies a pending query now - before the bar moves on, so it lands on the file it was typed for
		flushPending: () => { apply.run(); },
		cancelPending: () => { apply.cancel(); },
		teardown
	};
}
