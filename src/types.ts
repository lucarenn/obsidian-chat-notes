import { MarkdownPostProcessorContext, FrontMatterCache, TFile} from "obsidian";
import { ChatConfig } from "./settings";
import ChatNotesPlugin from "./main"


export class ArchiveContext {
    file: TFile;
	// messages: MessageEntry[];
	messageMap: Map<string, MessageEntry>
    renderedElements: Map<string, HTMLElement>;
	pinnedMessagesAmount: number;
	filterPinnedOnly: boolean;

    constructor(file: TFile, msgEntryMap: Map<string, MessageEntry>, pinnedMessages?: number) {
        this.file = file;
		// this.messages = msgEntries;
        this.messageMap = msgEntryMap;
		this.renderedElements = new Map();
		this.pinnedMessagesAmount = pinnedMessages ?? 0;
		this.filterPinnedOnly = false;
    }

	getEntry(id: string): MessageEntry {
        const entry = this.messageMap.get(id);
        if (!entry) throw new Error(`Message Entry  ${id} not found.`);
        return entry;
    }

	refreshStylesPerMessage(config: ChatConfig) {

		for (const entry of this.messageMap.values()) {
	
			if (!entry.element)
				continue;
	
			const pinned =
				entry.message.header.extra.pinned === "true";
	
			const color = pinned
				? config.messageHighlightColor
				: config.messageBgColor;
		
			if (!color) return;
	
			entry.element.style.setProperty(
				"--settings-msg-bg-color",
				color
			);
		}
	}

/*  BUMP Animation
	updateVisibility() {


		for (const entry of this.messageMap.values()) {
	
			if (!entry.element)
				continue;
	
			const isPinned = entry.message.header.extra.pinned === "true";
			
			console.log(isPinned);
	
			entry.element.classList.toggle(
				"hidden-by-pin-filter",
				!isPinned && !this.filterPinnedOnly	
			);

			entry.element.classList.add("bump");

			entry.element.addEventListener(
				"animationend",
				() => entry.element!.classList.remove("bump"),
				{ once: true }
			);

		}
		
		this.filterPinnedOnly = !this.filterPinnedOnly;
	}
	*/

	updateVisibility() {
		// Store initial positions of all message elements
		const initialPositions = new Map<HTMLElement, number>();
		for (const entry of this.messageMap.values()) {
			
			if (entry.element) {
				
				console.log(entry.element?.isConnected);
				initialPositions.set(entry.element, entry.element.getBoundingClientRect().top);
			}
		}
	
		this.filterPinnedOnly = !this.filterPinnedOnly;
	
		// Apply visibility changes to DOM
		for (const entry of this.messageMap.values()) {
			if (!entry.element) continue;
	
			const isPinned = entry.message.header.extra.pinned === "true";
	
			const shouldHide = this.filterPinnedOnly && !isPinned;
			entry.element.classList.toggle("hidden-by-pin-filter", shouldHide);
		}
	
		// Animate layout shift for elements that remain visible
		for (const entry of this.messageMap.values()) {
			const el = entry.element;
			if (!el || el.classList.contains("hidden-by-pin-filter")) continue;
	
			const firstTop = initialPositions.get(el);
			if (firstTop === undefined) continue;
	
			const lastTop = el.getBoundingClientRect().top;
			const deltaY = firstTop - lastTop;
	
			// If the position changed, slide it smoothly from old position to new position
			if (deltaY !== 0) {
				el.style.transform = `translateY(${deltaY}px)`;
				el.style.transition = "transform 0s";
				el.offsetHeight;
				el.style.transition = "transform 180ms cubic-bezier(0.34, 1.35, 0.64, 1)";
				el.style.transform = "";

				el.addEventListener("transitionend", () => {
					el.style.transition = "";
				}, { once: true });
			}
		}
	}
}

export interface MessageEntry {
	id: string;
	message: Message;
	startLine: number;
	endLine: number;
	element?: HTMLElement;
}

export type CreateHTMLParams = {
    plugin: ChatNotesPlugin;
	ctx: MarkdownPostProcessorContext;
	msg: Message;
	author_text: string;
	context: ArchiveContext;
	isReplyTarget: boolean;
	onToggle: (menu: HTMLElement) => void;
	onHighlight: (msgId: string, isPinned: boolean) => void;
	onReplyToggle: (msgId: string) => void;
	onScrollToReply: (targetId: string) => void;
};

export type CreateMenuParams = {
    plugin: ChatNotesPlugin;
	ctx: MarkdownPostProcessorContext;
	msg: Message;
	wrapper: HTMLElement;
	content: HTMLDivElement;
	onToggle: (menu: HTMLElement) => void;
	onHighlight: (msgId: string, isPinned: boolean) => void;
};


export class Header {
	constructor(
		public id: string,
		public author: string,
		public timestamp: string,
		public extra: Record<string, string> = {}   // for adding addional fields
	) {}

	static fromLines(lines: string[]): Header {
		const data: Record<string, string> = {};

		for (const line of lines) {
			const [key, ...rest] = line.split(":");
			if (!key || rest.length === 0) continue;

			data[key.trim()] = rest.join(":").trim();
		}

		const id = data["id"];
		if (id === undefined || id === ""){
			throw new Error("Message Header contains no ID.")
		}

		return new Header(
			id,
			data["author"] ?? "",
			data["timestamp"] ?? "",
			Object.fromEntries(
				Object.entries(data).filter(
					([k]) => k !== "author" && k !== "timestamp"
				)
			)
		);
	}

	toString(): string {
		const base = [
			`id: ${this.id}`,
			`author: ${this.author}`,
			`timestamp: ${this.timestamp}`,
		];

		const extraLines = Object.entries(this.extra).map(
			([k, v]) => `${k}: ${v}`
		);

		return [...base, ...extraLines, "~~~"].join("\n");
	}
}

export class Message {
	constructor(
		public header: Header,
		public content: string
	) {}


    setContent(content: string): Message{
        this.content = content;
        return this;
    }

	static fromString(rawMessage: string): Message {
		// expxts rawMessage to NOT contain the codeblock seperators (````chat-message and ````)
		const lines = rawMessage.trim().split("\n");

		// find header/content separator
		const separatorIndex = lines.indexOf("~~~");
		if (separatorIndex === -1) {
			throw new Error("Missing header separator '~~~'");
		}

		const headerLines = lines.slice(0, separatorIndex);
		const contentLines = lines.slice(separatorIndex + 1);
		const header = Header.fromLines(headerLines);

        let content = contentLines.join("\n");
        if (!content.startsWith("\n")) content = "\n" + content;
        if (!content.endsWith("\n")) content += "\n";

		return new Message(header, content);
	}

	toString(): string {
		return [
			"````chat-message",
			this.header.toString(),
			this.content,
			"````\n",
		].join("\n");
	}
}

export class ChatNote {
	constructor(
		public file: TFile,
		public isChatNote?: boolean,
		public inputCache?: string,
		public configCache?: ChatConfig,
		public yamlCache?: FrontMatterCache,
		public lastAppliedConfig?: ChatConfig,

		public lastId?: number,
		public lastAuthor?: string,
		public chatAuthor?: string,

		public replyTo?: string,	// id of the message the next sent message will reply to

	) {}

}
