import { MarkdownPostProcessorContext, FrontMatterCache, TFile} from "obsidian";
import { ChatConfig, DefaultAuthorMode } from "./settings";
import { isNumericId, compareNumericIds, incrementNumericId, getReadableTextColor } from "./util";
import ChatNotesPlugin from "./main"


export class ArchiveContext {
    file: TFile;
	messageMap: Map<string, MessageEntry>
    renderedElements: Map<string, HTMLElement>;
	pinnedMessagesAmount: number;
	filterPinnedOnly: boolean;

	// derived from the messages, rebuilt by refreshMessageIndex
	authors: Set<string> = new Set();
	lastAuthor?: string;
	maxMessageId = "0";

	// mirrored from the resolved config, refreshed by applyConfigToContext
	chatAuthor?: string;
	defaultAuthorMode: DefaultAuthorMode = "owner";

    constructor(file: TFile, msgEntryMap: Map<string, MessageEntry>, pinnedMessages?: number) {
        this.file = file;
        this.messageMap = msgEntryMap;
		this.renderedElements = new Map();
		this.pinnedMessagesAmount = pinnedMessages ?? 0;
		this.filterPinnedOnly = false;
		this.refreshMessageIndex();
    }

	// messageMap keeps the file's order, so the last entry with an author is the newest one
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

	nextMessageId(): string {
		return incrementNumericId(this.maxMessageId);
	}

	// with no owner set nothing matches, so every badge falls to the left gutter
	isOwnerMessage(msg: Message): boolean {
		const owner = this.chatAuthor?.trim();
		return !!owner && msg.header.author.trim() === owner;
	}

	// each mode falls back to the other, so a new chat / an ownerless chat still resolve
	resolveDefaultAuthor(): string {
		if (this.defaultAuthorMode === "previous") {
			return this.lastAuthor ?? this.chatAuthor ?? "";
		}

		return this.chatAuthor ?? this.lastAuthor ?? "";
	}

	// registers an appended message without a full reparse; `element` is filled in by the
	// codeblock processor when it renders the new block
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

			// set on the row, not the bubble: badge and tail are siblings of the bubble
			const row = entry.element.parentElement ?? entry.element;

			row.classList.toggle("is-owner", this.isOwnerMessage(entry.message));

			const pinned =
				entry.message.header.extra.pinned === "true";

			const color = pinned
				? config.messageHighlightColor
				: config.messageBgColor;

			// `continue`, not `return` - one colourless message must not abandon the loop
			if (!color) continue;

			row.style.setProperty(
				"--settings-msg-bg-color",
				color
			);
			row.style.setProperty(
				"--settings-msg-text-color",
				getReadableTextColor(color)
			);
		}
	}

	updateVisibility() {
		// FLIP animation: measure, toggle, then slide the surviving rows into place
		const initialPositions = new Map<HTMLElement, number>();
		for (const entry of this.messageMap.values()) {
			if (entry.element) {
				initialPositions.set(entry.element, entry.element.getBoundingClientRect().top);
			}
		}

		this.filterPinnedOnly = !this.filterPinnedOnly;

		for (const entry of this.messageMap.values()) {
			if (!entry.element) continue;

			const isPinned = entry.message.header.extra.pinned === "true";

			const shouldHide = this.filterPinnedOnly && !isPinned;
			entry.element.classList.toggle("hidden-by-pin-filter", shouldHide);
		}

		for (const entry of this.messageMap.values()) {
			const el = entry.element;
			if (!el || el.classList.contains("hidden-by-pin-filter")) continue;

			const firstTop = initialPositions.get(el);
			if (firstTop === undefined) continue;

			const lastTop = el.getBoundingClientRect().top;
			const deltaY = firstTop - lastTop;

			if (deltaY !== 0) {
				el.style.transform = `translateY(${deltaY}px)`;
				el.style.transition = "transform 0s";
				el.offsetHeight;	// forced reflow, so the transition below actually runs
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
			// every field with its own slot must be excluded, or toString() emits it twice
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

	// a body always opens and closes with a blank line - what keeps a
	// fromString/toString round trip stable
	private static normalizeContent(content: string): string {
		let normalized = content;
		if (!normalized.startsWith("\n")) normalized = "\n" + normalized;
		if (!normalized.endsWith("\n")) normalized += "\n";
		return normalized;
	}

	static create(header: Header, content: string): Message {
		return new Message(header, Message.normalizeContent(content));
	}

	static fromString(rawMessage: string): Message {
		// expects rawMessage to NOT contain the codeblock seperators (````chat-message and ````)
		const lines = rawMessage.trim().split("\n");

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
