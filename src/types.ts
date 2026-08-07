import { MarkdownPostProcessorContext, FrontMatterCache, TFile} from "obsidian";
import { ChatConfig, DefaultAuthorMode } from "./settings";
import { isNumericId, compareNumericIds, incrementNumericId } from "./util";
import ChatNotesPlugin from "./main"


export class ArchiveContext {
    file: TFile;
	// messages: MessageEntry[];
	messageMap: Map<string, MessageEntry>
    renderedElements: Map<string, HTMLElement>;
	pinnedMessagesAmount: number;
	filterPinnedOnly: boolean;

	/* Derived from the messages themselves, so refreshMessageIndex rebuilds them whenever
	   the message set changes: everyone who has posted, whoever posted last, and the
	   highest numeric id in the file (a decimal string - see incrementNumericId). */
	authors: Set<string> = new Set();
	lastAuthor?: string;
	maxMessageId = "0";

	/* Mirrored from the resolved config (global settings + YAML overrides) instead, so
	   these are refreshed by applyConfigToContext when the config changes - not here. */
	chatAuthor?: string;
	defaultAuthorMode: DefaultAuthorMode = "owner";

    constructor(file: TFile, msgEntryMap: Map<string, MessageEntry>, pinnedMessages?: number) {
        this.file = file;
		// this.messages = msgEntries;
        this.messageMap = msgEntryMap;
		this.renderedElements = new Map();
		this.pinnedMessagesAmount = pinnedMessages ?? 0;
		this.filterPinnedOnly = false;
		this.refreshMessageIndex();
    }

	/* messageMap preserves the file's own message order (parseMessages inserts them top
	   to bottom), so the last entry carrying an author is the chat's most recent one. */
	refreshMessageIndex() {
		const authors = new Set<string>();
		let lastAuthor: string | undefined;
		let maxMessageId = "0";

		for (const entry of this.messageMap.values()) {
			const author = entry.message.header.author.trim();
			if (author) {
				authors.add(author);
				lastAuthor = author;
			}

			// a non-numeric id simply doesn't take part in the maximum
			const id = entry.message.header.id.trim();
			if (isNumericId(id) && compareNumericIds(id, maxMessageId) > 0) {
				maxMessageId = id;
			}
		}

		this.authors = authors;
		this.lastAuthor = lastAuthor;
		this.maxMessageId = maxMessageId;
	}

	/* Id for the next message: one past the highest already in the file. */
	nextMessageId(): string {
		return incrementNumericId(this.maxMessageId);
	}

	/* The author a new message is written with when the input's author field is left
	   empty. Each mode falls back to the other, so a brand new chat still resolves to the
	   owner and a chat with no owner set still resolves to whoever posted last. */
	resolveDefaultAuthor(): string {
		if (this.defaultAuthorMode === "previous") {
			return this.lastAuthor ?? this.chatAuthor ?? "";
		}

		return this.chatAuthor ?? this.lastAuthor ?? "";
	}

	/* Registers a freshly appended message, keeping the context in step with the file
	   without a full reparse. `element` is left unset - the codeblock processor fills it
	   in when it renders the new block. */
	addMessage(entry: MessageEntry) {
		this.messageMap.set(entry.id, entry);

		if (entry.message.header.extra.pinned === "true") {
			this.pinnedMessagesAmount += 1;
		}

		this.refreshMessageIndex();
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
			// every field that has its own slot on Header must be excluded here, or it
			// ends up in `extra` as well and toString() emits the line twice
			Object.fromEntries(
				Object.entries(data).filter(
					([k]) => k !== "id" && k !== "author" && k !== "timestamp"
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

	/* A stored body always opens and closes with a blank line, matching how imported
	   messages are written - which is what keeps a fromString/toString round trip stable. */
	private static normalizeContent(content: string): string {
		let normalized = content;
		if (!normalized.startsWith("\n")) normalized = "\n" + normalized;
		if (!normalized.endsWith("\n")) normalized += "\n";
		return normalized;
	}

	/* Builds a message from scratch (as opposed to parsing one out of a file), applying
	   the same body normalization fromString does. */
	static create(header: Header, content: string): Message {
		return new Message(header, Message.normalizeContent(content));
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

		return new Message(
			header,
			Message.normalizeContent(contentLines.join("\n"))
		);
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
