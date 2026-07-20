import { MarkdownPostProcessorContext, FrontMatterCache, TFile} from "obsidian";
import { ChatConfig } from "./settings";
import ChatNotesPlugin from "./main"


export class ArchiveContext {
    file: TFile;
	// messages: MessageEntry[];
	messageMap: Map<string, MessageEntry>
    renderedElements: Map<string, HTMLElement>;
	pinnedMessagesAmount: number;

    constructor(file: TFile, msgEntryMap: Map<string, MessageEntry>) {
        this.file = file;
		// this.messages = msgEntries;
        this.messageMap = msgEntryMap;
		this.renderedElements = new Map();
		this.pinnedMessagesAmount = 0;
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
	onToggle: (menu: HTMLElement) => void;
	onHighlight: (msgId: string, isPinned: boolean) => void;
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

	) {}

}
