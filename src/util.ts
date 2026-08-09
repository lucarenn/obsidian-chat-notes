import { MarkdownView, App, TFile, TAbstractFile} from "obsidian";
import { Message, MessageEntry } from "./types"


export function isChatFile(app: App, file: TFile): boolean {
	const cache = app.metadataCache.getFileCache(file);
	return cache?.frontmatter?.type === "chat";
}

// kept between calls - all this needs is the 2d context's color parser
let colorProbe: CanvasRenderingContext2D | null | undefined;

function getColorProbe(): CanvasRenderingContext2D | null {
	if (colorProbe === undefined) {
		colorProbe = document.createElement("canvas").getContext("2d");
	}
	return colorProbe;
}

/* RGB channels of any color CSS accepts ("white", "#abc", "rgb(...)", "hsl(...)"), via the
   canvas color parser - a YAML override is whatever the user typed, not just hex. Alpha is
   ignored: what shows through a translucent bubble isn't knowable from here. */
function parseColorChannels(color: string): [number, number, number] | undefined {
	const probe = getColorProbe();
	if (!probe) return undefined;

	// a rejected value leaves fillStyle untouched, so it is probed over two different
	// sentinels - one sentinel alone would misread that exact color as invalid
	probe.fillStyle = "#000000";
	probe.fillStyle = color;
	const overBlack = probe.fillStyle;

	probe.fillStyle = "#ffffff";
	probe.fillStyle = color;
	const overWhite = probe.fillStyle;

	// fillStyle may also hold a gradient/pattern, so only the string form is a color
	if (typeof overWhite !== "string" || overBlack !== overWhite) return undefined;

	if (overWhite.startsWith("#")) {
		const value = parseInt(overWhite.slice(1), 16);
		if (Number.isNaN(value)) return undefined;
		return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
	}

	// guarded on the rgb prefix: wide-gamut input serialises as "color(srgb 1 0 0)", whose
	// 0-1 components would otherwise be read as 0-255 ones
	if (!overWhite.startsWith("rgb")) return undefined;

	const channels = overWhite.match(/[\d.]+/g);
	if (!channels || channels.length < 3) return undefined;

	return [Number(channels[0]), Number(channels[1]), Number(channels[2])];
}

// black or white text for readable contrast on a user-chosen background; falls back to
// light text for a value CSS itself can't read as a color
export function getReadableTextColor(color: string): string {
	const channels = parseColorChannels(color);
	if (!channels) return "#f5f5f5";

	const [r, g, b] = channels;

	const brightness = (r * 299 + g * 587 + b * 114) / 1000;
	return brightness > 150 ? "#1a1a1a" : "#f5f5f5";
}

/* Message ids are compared and incremented as decimal strings, never as numbers: an
   imported Discord snowflake is 19 digits, past what a JS number holds exactly, so
   `Number(maxId) + 1` would silently land on an existing id (or skip one). */

export function isNumericId(id: string): boolean {
	return /^\d+$/.test(id);
}

function stripLeadingZeros(value: string): string {
	const trimmed = value.replace(/^0+/, "");
	return trimmed === "" ? "0" : trimmed;
}

// longer number wins; equal lengths compare lexicographically
export function compareNumericIds(a: string, b: string): number {
	const left = stripLeadingZeros(a);
	const right = stripLeadingZeros(b);

	if (left.length !== right.length) return left.length - right.length;
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

// schoolbook carry, exact at any length
export function incrementNumericId(value: string): string {
	const digits = stripLeadingZeros(value).split("");

	for (let index = digits.length - 1; index >= 0; index--) {
		const digit = Number(digits[index] ?? "0") + 1;

		if (digit < 10) {
			digits[index] = String(digit);
			return digits.join("");
		}

		digits[index] = "0"; // carry into the next column up
	}

	// every column carried (999 -> 1000), so the number gained a digit
	return "1" + digits.join("");
}

// DD.MM.YYYY with an optional HH:MM, leading zeros optional
export const TIMESTAMP_PATTERN = /^\d{1,2}\.\d{1,2}\.\d{4}( \d{1,2}:\d{2})?$/;
export const TIMESTAMP_PLACEHOLDER = "DD.MM.YYYY HH:MM";

export function isValidTimestamp(value: string): boolean {
	return TIMESTAMP_PATTERN.test(value.trim());
}

export function formatTimestamp(date: Date = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");

	return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`
		+ ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function scrollDocument(view: MarkdownView, position: "top" | "bottom") {
	const preview = view.containerEl.querySelector(".markdown-preview-view");
	const cmScroller = view.containerEl.querySelector(".cm-scroller");

	const targetTop = position === "top" ? 0 : Number.MAX_SAFE_INTEGER;

	if (cmScroller) {
		cmScroller.scrollTo({ top: targetTop });
	}

	if (preview) {
		preview.scrollTop = position === "top" ? 0 : preview.scrollHeight;
	}
}

export function extractMessageIdFromSource(source: string): string {
	const newline = source.indexOf("\n");
	const firstLine = newline === -1 ? source : source.slice(0, newline);

	const colon = firstLine.indexOf(":");
	if (colon === -1) {
		throw new Error("Missing ':' in first line.");
	}

	const identifier = firstLine.slice(0, colon).trim();
	const value = firstLine.slice(colon + 1).trim();

	if (identifier !== "id" || !value) {
		throw new Error("First line must be 'id: ...'");
	}

	return value;
}

export function parseMessages(source: string): [Map<string, MessageEntry>, number] {

	const messages = new Map<string, MessageEntry>();
	const lines = source.split("\n");
	let insideBlock = false;
	let currentBlock: string[] = [];
	let currentStartLine = 0;
	let currentLastLine = -1;
	let pinnedMessageCounter = 0

	for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
		const line = lines[lineNumber];
		if (!line) continue;

		if (!insideBlock && line.trim() === "````chat-message") {
			insideBlock = true;
			currentBlock = [];
			currentStartLine = lineNumber;
			continue;
		}

		if (insideBlock && line.trim() === "````") {

			insideBlock = false;
			currentLastLine = lineNumber;

			try {
				const rawMessage = currentBlock.join("\n");
				const message = Message.fromString(rawMessage);

				messages.set(
					message.header.id,
					{
						id: message.header.id,
						message,
						startLine: currentStartLine,
						endLine: currentLastLine
					}
				);

				if(message.header.extra.pinned === "true") {
					pinnedMessageCounter += 1
				}

			} catch (e) {
				console.warn(
					"Failed to parse chat message",
					e
				);
			}

			continue;
		}

		if (insideBlock) {
			currentBlock.push(line);
		}
	}

	return [messages, pinnedMessageCounter];
}

/* Every html container the file is currently rendered in - one per open leaf. Flat and
   deduped: previewMode's container lives *inside* contentEl, so keeping both would find
   every message row twice, which is harmless for setting a CSS variable but not for a
   measure-and-animate pass. Always an array, so "not open anywhere" is an empty loop
   rather than a branch at every call site. */
export function getActiveContainers(app: App, file: TAbstractFile): HTMLElement[] {

	const leaves = app.workspace.getLeavesOfType("markdown");

	const containers: HTMLElement[] = [];
	for (const leaf of leaves) {
		const view = leaf.view;

		if (!(view instanceof MarkdownView)) continue;
		if (view.file?.path !== file.path) continue;

		for (const maybe of [view.previewMode?.containerEl, view.contentEl]) {
			if (!(maybe instanceof HTMLElement)) continue;
			const candidate: HTMLElement = maybe;

			// keep only the outermost of any nested pair
			if (containers.some(existing => existing.contains(candidate))) continue;
			for (let i = containers.length - 1; i >= 0; i--) {
				const existing = containers[i];
				if (existing && candidate.contains(existing)) containers.splice(i, 1);
			}

			containers.push(candidate);
		}
	}

	return containers;
}

/* The rendered rows of a chat file, found by querying the DOM rather than by remembering
   nodes. A message has one row per place it is rendered (reading view and live preview are
   both mounted, the same note can be open in several leaves), and rows come and go as the
   view scrolls - so a stored reference is stale as soon as anything re-renders, while a
   query is right by construction.

   Searched from the document down, NOT from the leaf containers a file is open in. Obsidian
   renders chat blocks in more places than those - embeds, hover popovers, canvas cards,
   popout windows - and a sweep that misses one leaves a stray row behind (the pin filter
   hiding only some of the messages was exactly this). `data-chat-src` is what keeps a
   document-wide search correct: it pins each row to the note that owns it, so an embedded
   chat's rows never answer for the host's ids. */
function rowsFor(app: App, sourcePath: string, msgId?: string): HTMLElement[] {
	const selector = msgId === undefined
		? `.chat-message-row[data-msg-id][data-chat-src="${CSS.escape(sourcePath)}"]`
		: `.chat-message-row[data-msg-id="${CSS.escape(msgId)}"][data-chat-src="${CSS.escape(sourcePath)}"]`;

	const rows: HTMLElement[] = [];

	for (const doc of chatDocuments(app)) {
		for (const row of Array.from(doc.querySelectorAll(selector))) {
			if (row instanceof HTMLElement) rows.push(row);
		}
	}

	return rows;
}

/* Every document the workspace renders into. A popout window is a separate `window` with its
   own document - not an iframe - so it is reached through the leaves that live in it rather
   than by scanning the main document. */
function chatDocuments(app: App): Document[] {
	const docs = new Set<Document>([document]);

	app.workspace.iterateAllLeaves(leaf => {
		const doc = leaf.view?.containerEl?.ownerDocument;
		if (doc) docs.add(doc);
	});

	return Array.from(docs);
}

// every rendered row for one message
export function findMessageRows(app: App, file: TFile, msgId: string): HTMLElement[] {
	return rowsFor(app, file.path, msgId);
}

/* All rendered rows of a file, grouped by the scroller they live in and keyed by message id.
   Grouped because geometry is per scroller: a measure-then-animate pass has to compare each
   row against others it actually shares a layout with, not across leaves. */
export function collectMessageRows(app: App, file: TFile): Map<string, HTMLElement[]>[] {
	const byScroller = new Map<Element | null, Map<string, HTMLElement[]>>();

	for (const row of rowsFor(app, file.path)) {
		const id = row.dataset.msgId;
		if (id === undefined) continue;

		const scroller = row.closest(".cm-scroller, .markdown-preview-view");

		let byId = byScroller.get(scroller);
		if (!byId) {
			byId = new Map<string, HTMLElement[]>();
			byScroller.set(scroller, byId);
		}

		const existing = byId.get(id);
		if (existing) existing.push(row);
		else byId.set(id, [row]);
	}

	return Array.from(byScroller.values());
}
