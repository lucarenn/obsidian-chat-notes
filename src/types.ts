import { MarkdownPostProcessorContext, FrontMatterCache, TFile} from "obsidian";
import { ChatConfig, DefaultAuthorMode } from "./settings";
import { isNumericId, compareNumericIds, incrementNumericId } from "./util";
import ChatNotesPlugin from "./main"


/* A parsed chat file: everything derivable from its text, and nothing else.

   Deliberately holds no DOM references and no UI state. It is disposable - dropped whenever
   the file changes and rebuilt lazily on the next render (see invalidateArchiveContext in
   main.ts) - so anything that must outlive a file edit belongs on ChatNote instead, and
   anything that describes the rendered page is found by querying the DOM.

   Nothing mutates a context after construction except applyConfigToContext. That invariant
   is what makes "throw it away and reparse" safe: a caller holding an older context across
   an await sees a consistent snapshot rather than a half-updated one. */
export class ArchiveContext {
    file: TFile;
	messageMap: Map<string, MessageEntry>

	// all derived from the messages, rebuilt together by refreshMessageIndex
	authors: Set<string> = new Set();
	lastAuthor?: string;
	maxMessageId = "0";
	pinnedMessagesAmount = 0;

	// mirrored from the resolved config, refreshed by applyConfigToContext
	chatAuthor?: string;
	defaultAuthorMode: DefaultAuthorMode = "owner";

    constructor(file: TFile, msgEntryMap: Map<string, MessageEntry>) {
        this.file = file;
        this.messageMap = msgEntryMap;
		this.refreshMessageIndex();
    }

	// messageMap keeps the file's order, so the last entry with an author is the newest one
	refreshMessageIndex() {
		const authors = new Set<string>();
		let lastAuthor: string | undefined;
		let maxMessageId = "0";
		let pinned = 0;

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

			if (entry.message.header.extra.pinned === "true") pinned += 1;
		}

		this.authors = authors;
		this.lastAuthor = lastAuthor;
		this.maxMessageId = maxMessageId;
		// counted, never incremented by hand - a running total was a second thing to keep
		// in step with the file, and it drifted whenever a message was registered twice
		this.pinnedMessagesAmount = pinned;
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

	/* Registers a message the parse hasn't seen yet (one just appended, or one the codeblock
	   processor met before the reparse landed) so author/next-id lookups include it right
	   away. Idempotent: the same block renders once per open container, and each render
	   would otherwise re-register it. */
	addMessage(entry: MessageEntry) {
		if (this.messageMap.has(entry.id)) return;

		this.messageMap.set(entry.id, entry);
		this.refreshMessageIndex();
	}

}

export interface MessageEntry {
	id: string;
	message: Message;

	/* Where the block sat in the text this entry was parsed from. A scroll hint only - use
	   it to jump an unrendered message into view, NEVER to write to the file. Any edit
	   anywhere above a message shifts it, and the context can lag the file by one metadata
	   debounce, so a write keyed off these numbers can land in a different message's header.
	   Writes locate the block by id in the text they are about to modify (see
	   withMessageBlock in main.ts). */
	startLine: number;
	endLine: number;
}

export type CreateHTMLParams = {
    plugin: ChatNotesPlugin;
	ctx: MarkdownPostProcessorContext;
	msg: Message;
	author_text: string;
	context: ArchiveContext;
	onToggle: (menu: HTMLElement) => void;
	onHighlight: (msgId: string) => void;	// toggles pinned; the new state is decided at the write
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
	onHighlight: (msgId: string) => void;	// toggles pinned; the new state is decided at the write
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

/* Per-file UI state, held in a WeakMap keyed by TFile (see main.ts). Distinct from
   ArchiveContext in lifetime: this is what the user did, not what the file says, so it must
   survive a context rebuild - which now happens on every save - and a rename. */
export class ChatNote {
	constructor(
		public file: TFile,
		public isChatNote?: boolean,
		public inputCache?: string,
		public configCache?: ChatConfig,
		public yamlCache?: FrontMatterCache,
		public lastAppliedConfig?: ChatConfig,

		public replyTo?: string,	// id of the message the next sent message will reply to
		public pinFilter?: boolean,	// showing pinned messages only

	) {}

}
