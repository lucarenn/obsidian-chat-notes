import { MarkdownPostProcessorContext, MarkdownRenderChild } from "obsidian";

/* Manual `position: sticky` for elements in a message row's gutter.

   CSS sticky works in Reading View but goes inert in Live Preview, where Obsidian mounts
   each message as a CodeMirror block widget nested inside flex containers rather than
   Reading View's flat DOM. Tracking scroll by hand sidesteps that ancestor chain, so
   gutter elements behave identically in both view modes.

   The always-visible author badge uses the registry below; the hover-only reply icon
   (attachStickyReplyIcon in ui.ts) keeps its own listeners and shares only the maths. */

// how far below the top of the visible scroll area the element comes to rest
const SCROLL_OFFSET = 16;

// keeps the element clear of Reading View's code-block "edit" button in that same corner
export const DEFAULT_TOP_INSET = 18;

// room to leave at each end of the row; `top` doubles as the resting inset
export type StickyInsets = { top: number; bottom: number };

export const DEFAULT_INSETS: StickyInsets = { top: DEFAULT_TOP_INSET, bottom: 0 };

// offset from the row's top: pinned near the top of the visible scroll area, but clamped
// within the row, so the element stays inside the message it belongs to
export function computeStickyOffset(
	scrollerRect: DOMRect,
	rowRect: DOMRect,
	targetHeight: number,
	insets: StickyInsets = DEFAULT_INSETS
): number {
	const min = rowRect.top + insets.top;
	const max = rowRect.bottom - targetHeight - insets.bottom;

	// on a message too short for the element plus its insets the bounds cross; staying
	// inside the message wins there, floored at the row's top
	const target = max < min
		? Math.max(rowRect.top, max)
		: Math.min(Math.max(scrollerRect.top + SCROLL_OFFSET, min), max);

	return target - rowRect.top;
}

type StickyEntry = {
	row: HTMLElement;
	target: HTMLElement;
	// read per update, not captured once - the corner radius is a live setting
	insets: () => StickyInsets;
};

type ScrollerGroup = {
	// keyed by row, so the observer callback resolves a record straight to its entry
	entries: Map<Element, StickyEntry>;
	// only on-screen rows are recomputed, keeping scroll cost proportional to what's
	// visible rather than to the length of the chat
	visible: Set<StickyEntry>;
	observer: IntersectionObserver;
	onScroll: () => void;
	rafId: number | null;
};

const groups = new Map<Element, ScrollerGroup>();

function updateEntry(entry: StickyEntry, scrollerRect: DOMRect) {
	// skips switched-off entries (a badge is display:none while the setting is disabled)
	if (entry.target.offsetHeight === 0) return;

	const offset = computeStickyOffset(
		scrollerRect,
		entry.row.getBoundingClientRect(),
		entry.target.offsetHeight,
		entry.insets()
	);

	entry.target.style.transform = `translateY(${offset}px)`;
}

function getGroup(scroller: Element): ScrollerGroup {
	const existing = groups.get(scroller);
	if (existing) return existing;

	const group: ScrollerGroup = {
		entries: new Map(),
		visible: new Set(),
		observer: new IntersectionObserver(
			(records) => {
				for (const record of records) {
					const entry = group.entries.get(record.target);
					if (!entry) continue;

					if (record.isIntersecting) {
						group.visible.add(entry);
					} else {
						group.visible.delete(entry);
					}
				}

				group.onScroll();
			},
			{ root: scroller }
		),
		onScroll: () => {
			if (group.rafId !== null) return;

			group.rafId = requestAnimationFrame(() => {
				group.rafId = null;

				// one rect for the whole pass - it's the same scroller for every entry
				const scrollerRect = scroller.getBoundingClientRect();
				for (const entry of group.visible) {
					updateEntry(entry, scrollerRect);
				}
			});
		},
		rafId: null
	};

	scroller.addEventListener("scroll", group.onScroll, { passive: true });
	window.addEventListener("resize", group.onScroll, { passive: true });

	groups.set(scroller, group);
	return group;
}

function unregister(scroller: Element, entry: StickyEntry) {
	const group = groups.get(scroller);
	if (!group) return;

	group.observer.unobserve(entry.row);
	group.entries.delete(entry.row);
	group.visible.delete(entry);

	if (group.entries.size > 0) return;

	// last element in this view went away - tear the whole group down
	if (group.rafId !== null) cancelAnimationFrame(group.rafId);
	group.observer.disconnect();
	scroller.removeEventListener("scroll", group.onScroll);
	window.removeEventListener("resize", group.onScroll);
	groups.delete(scroller);
}

// keeps `target` pinned within `row` for as long as the row is rendered, sharing one
// scroll listener and one observer with every other tracked row in the same view
export function registerSticky(
	row: HTMLElement,
	target: HTMLElement,
	ctx: MarkdownPostProcessorContext,
	insets: () => StickyInsets = () => DEFAULT_INSETS
) {
	let scroller: Element | null = null;
	let entry: StickyEntry | null = null;

	// deferred a frame on purpose: the row is still detached at this point, so closest()
	// would find no scroller at all
	const frame = requestAnimationFrame(() => {
		scroller = row.closest(".cm-scroller, .markdown-preview-view");
		if (!scroller) return;

		const group = getGroup(scroller);
		entry = { row, target, insets };

		group.entries.set(row, entry);
		// observing fires an immediate record, which places the element without waiting
		// for the reader to scroll
		group.observer.observe(row);
	});

	// ties the entry's life to the rendered message: a re-render, file switch or closed
	// leaf all unload the child, which is the only signal that the row is gone
	const child = new MarkdownRenderChild(target);
	child.onunload = () => {
		cancelAnimationFrame(frame);
		if (scroller && entry) unregister(scroller, entry);
	};
	ctx.addChild(child);
}
