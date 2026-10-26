import { EMOJI_CATEGORIES, QUICK_REACTIONS, emojiByName, emojiName } from "./emoji-data";
import { isValidReactionToken } from "./reactions";

// gap between the anchor and the picker, and the minimum distance kept from the window edges
const ANCHOR_GAP = 6;
const EDGE_MARGIN = 8;

export interface EmojiPicker {
	anchor: HTMLElement;
	contains: (node: Node) => boolean;
	close: () => void;
}

/* A popover attached to the anchor's own document body, so the bubble's overflow cannot clip it
   and it works in popout windows. It closes itself on a pick, Escape, a pointer press outside,
   a scroll or a resize; `onClose` runs once, however it closed. */
export function openEmojiPicker(
	anchor: HTMLElement,
	onPick: (emoji: string) => void,
	onClose: () => void
): EmojiPicker {

	const doc = anchor.doc;
	const win = anchor.win;

	const picker = doc.body.createDiv("msg-emoji-picker");
	picker.setAttribute("role", "dialog");
	picker.setAttribute("aria-label", "Add reaction");

	let closed = false;

	const pick = (emoji: string) => {
		close();
		onPick(emoji);
	};

	const addEmojiButton = (parent: HTMLElement, emoji: string) => {
		const btn = parent.createEl("button", { cls: "msg-emoji-picker-item", text: emoji });
		btn.type = "button";
		const name = emojiName(emoji);
		btn.setAttribute("aria-label", name !== undefined ? `:${name}:` : emoji);
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			pick(emoji);
		});
		return btn;
	};

	const quickRow = picker.createDiv("msg-emoji-picker-quick");
	for (const emoji of QUICK_REACTIONS) addEmojiButton(quickRow, emoji);

	const input = picker.createEl("input", { cls: "msg-emoji-picker-input" });
	input.type = "text";
	input.placeholder = "Search, or type or paste an emoji";
	input.setAttribute("aria-label", "Custom reaction");

	// each category's heading, items and named buttons, for the filter below
	type GridItem = { btn: HTMLElement; name: string };
	const sections: { heading: HTMLElement; items: HTMLElement; buttons: GridItem[] }[] = [];

	const grid = picker.createDiv("msg-emoji-picker-grid");
	for (const category of EMOJI_CATEGORIES) {
		const heading = grid.createDiv({ cls: "msg-emoji-picker-category", text: category.name });
		const items = grid.createDiv("msg-emoji-picker-items");
		const buttons = category.emoji.map(([emoji, name]) => ({ btn: addEmojiButton(items, emoji), name }));
		sections.push({ heading, items, buttons });
	}
	const gridItems = sections.flatMap(section => section.buttons);

	// a name being typed ("fir", ":fire"), as opposed to a pasted emoji or custom token
	const typedName = () => /^:?[\w+-]+:?$/.test(input.value.trim())
		? input.value.trim().toLowerCase().replace(/^:|:$/g, "")
		: "";

	// shows only the emoji whose name contains what is typed; the quick row hides meanwhile
	const applyFilter = () => {
		const query = typedName();
		quickRow.toggle(query === "");
		for (const { heading, items, buttons } of sections) {
			let any = false;
			for (const { btn, name } of buttons) {
				const match = name.includes(query);
				btn.toggle(match);
				any ||= match;
			}
			heading.toggle(any);
			items.toggle(any);
		}
	};

	input.addEventListener("input", () => {
		input.classList.remove("is-invalid");
		applyFilter();
	});
	/* Enter takes an exact name first (fire, :fire:), then the first emoji the filter left, and
	   otherwise the text itself, so pasted emoji and custom tokens still work. */
	input.addEventListener("keydown", (e) => {
		if (e.key !== "Enter") return;
		e.preventDefault();

		const value = input.value.trim();
		const query = typedName();
		const first = query === "" ? undefined : gridItems.find(item => item.name.includes(query));
		const emoji = emojiByName(value) ?? (first ? emojiByName(first.name) : undefined);

		if (emoji !== undefined) pick(emoji);
		else if (isValidReactionToken(value)) pick(value);
		else input.classList.add("is-invalid");
	});

	// clicks inside must not reach the document handler that closes the action menu
	picker.addEventListener("click", (e) => e.stopPropagation());

	const onPointerDown = (e: PointerEvent) => {
		const target = e.target as Node | null;
		if (!target || picker.contains(target) || anchor.contains(target)) return;
		close();
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key !== "Escape") return;
		e.preventDefault();
		e.stopPropagation();
		close();
	};

	const onScroll = (e: Event) => {
		const target = e.target as Node | null;
		if (target && picker.contains(target)) return;
		close();
	};

	const onResize = () => close();

	doc.addEventListener("pointerdown", onPointerDown, true);
	doc.addEventListener("keydown", onKeyDown, true);
	doc.addEventListener("scroll", onScroll, true);
	win.addEventListener("resize", onResize);

	function close() {
		if (closed) return;
		closed = true;

		doc.removeEventListener("pointerdown", onPointerDown, true);
		doc.removeEventListener("keydown", onKeyDown, true);
		doc.removeEventListener("scroll", onScroll, true);
		win.removeEventListener("resize", onResize);

		picker.remove();
		onClose();
	}

	positionPicker(picker, anchor, win);
	input.focus();

	return {
		anchor,
		contains: (node) => picker.contains(node),
		close
	};
}

// below the anchor, right-aligned to it; above when there is no room below
function positionPicker(picker: HTMLElement, anchor: HTMLElement, win: Window) {
	const rect = anchor.getBoundingClientRect();
	const width = picker.offsetWidth;
	const height = picker.offsetHeight;

	let top = rect.bottom + ANCHOR_GAP;
	if (top + height > win.innerHeight - EDGE_MARGIN) {
		top = Math.max(EDGE_MARGIN, rect.top - height - ANCHOR_GAP);
	}

	const maxLeft = Math.max(EDGE_MARGIN, win.innerWidth - width - EDGE_MARGIN);
	const left = Math.min(Math.max(EDGE_MARGIN, rect.right - width), maxLeft);

	picker.setCssStyles({ top: `${top}px`, left: `${left}px` });
}
