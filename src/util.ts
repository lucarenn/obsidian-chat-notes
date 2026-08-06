import { MarkdownView, App, TFile, TAbstractFile} from "obsidian";
import { Message, MessageEntry } from "./types"


export function isChatFile(app: App, file: TFile): boolean {
	const cache = app.metadataCache.getFileCache(file);
	return cache?.frontmatter?.type === "chat";
}

/* Picks black or white text for readable contrast against an arbitrary user-chosen hex
   background color, using the standard perceived-brightness formula (weights green
   highest, blue lowest, matching human luminance sensitivity). */
export function getReadableTextColor(hex: string): string {
	const clean = hex.replace("#", "");
	const full = clean.length === 3
		? clean.split("").map(c => c + c).join("")
		: clean;

	const value = parseInt(full, 16);
	if (full.length !== 6 || Number.isNaN(value)) return "#f5f5f5";

	const r = (value >> 16) & 255;
	const g = (value >> 8) & 255;
	const b = value & 255;

	const brightness = (r * 299 + g * 587 + b * 114) / 1000;
	return brightness > 150 ? "#1a1a1a" : "#f5f5f5";
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

		// Start of chat-message block
		if (!insideBlock && line.trim() === "````chat-message") {
			insideBlock = true;
			currentBlock = [];
			currentStartLine = lineNumber;
			continue;
		}

		// End of codeblock
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

		// Collect message contents
		if (insideBlock) {
			currentBlock.push(line);
		}
	}

	return [messages, pinnedMessageCounter];
}

export function getActiveContainers(app: App, file: TAbstractFile){
	// get all html containers of the given file (multiple depending on mode and if the file is opened multiple times) 

	const leaves = app.workspace.getLeavesOfType("markdown");

	const containers = []
	for (const leaf of leaves) {
		const view = leaf.view;
	
		if (!(view instanceof MarkdownView)) continue;
		if (view.file?.path !== file.path) continue;

		// get containers for reading and preview mode
		const fileContainers = [
			view.previewMode?.containerEl,
			view.contentEl,
			// view.editor?.cm?.dom // raw CodeMirror editor DOM, needed?
		];

		// only return available containers
		const availableFileContaiers = []
		for (const container of fileContainers){
			if (container instanceof HTMLElement) {
				availableFileContaiers.push(container)
			}
		}

		containers.push(availableFileContaiers)
	}

	if (containers.length == 0) return;

	return containers;
}
