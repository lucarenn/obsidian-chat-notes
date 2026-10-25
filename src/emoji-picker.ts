import { EMOJI_CATEGORIES, QUICK_REACTIONS } from "./emoji-data";
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
		btn.setAttribute("aria-label", emoji);
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			pick(emoji);
		});
	};

	const quickRow = picker.createDiv("msg-emoji-picker-quick");
	for (const emoji of QUICK_REACTIONS) addEmojiButton(quickRow, emoji);

	const input = picker.createEl("input", { cls: "msg-emoji-picker-input" });
	input.type = "text";
	input.placeholder = "Type or paste an emoji";
	input.setAttribute("aria-label", "Custom reaction");

	input.addEventListener("input", () => input.classList.remove("is-invalid"));
	input.addEventListener("keydown", (e) => {
		if (e.key !== "Enter") return;
		e.preventDefault();

		const value = input.value.trim();
		if (isValidReactionToken(value)) pick(value);
		else input.classList.add("is-invalid");
	});

	const grid = picker.createDiv("msg-emoji-picker-grid");
	for (const category of EMOJI_CATEGORIES) {
		grid.createDiv({ cls: "msg-emoji-picker-category", text: category.name });
		const items = grid.createDiv("msg-emoji-picker-items");
		for (const emoji of category.emoji) addEmojiButton(items, emoji);
	}

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
