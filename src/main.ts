import { Plugin, MarkdownRenderer, TFile, MarkdownView, WorkspaceLeaf, TAbstractFile, Notice, normalizePath } from "obsidian";
import { Header, Message, ChatNote, ArchiveContext, MessageEntry } from "./types"
import { DEFAULT_SETTINGS, ChatNotesPluginSettings, ChatNotesSettingTab, ChatConfig, getFileOverrides, resolveConfig } from "./settings"
import { createElementsHTML, addScrollButtons, createChatInput, addPinButton, addScrollMsgButton } from "./ui"
import { isChatFile, scrollDocument, extractMessageIdFromSource, parseMessages, getActiveContainers, getReadableTextColor, formatTimestamp } from "./util"

/* Base name for notes made by the "Create new chat note" command; a numeric suffix is
   appended if the folder already holds one. */
const NEW_CHAT_NOTE_NAME = "Untitled chat";

/* How long "Scroll to bottom on send" keeps the view pinned to the end while the message
   it was sent for renders and settles (see scrollToBottomAfterSend). */
const SCROLL_ON_SEND_PIN_MS = 500;

export default class ChatNotesPlugin extends Plugin {

	openMenu: HTMLElement | null = null;
	settings: ChatNotesPluginSettings;
	chatInputEl: HTMLElement;
	chatTextareaEl: HTMLTextAreaElement;
	chatReplyBannerEl: HTMLElement;
	chatReplyTextEl: HTMLElement;
	resizeObserver: ResizeObserver | null = null;
	currentFile: TFile | null = null;
	ribbonIconEl: HTMLElement | null = null;

	private chatNotes = new WeakMap<TFile, ChatNote>();			// holds metadata and cache of the files
	private archiveContexts = new Map<string, Promise<ArchiveContext>>();	// holds messages/content of the files

	activeEditor: {
		container: HTMLElement;
		restore: () => void;
	} | null = null;


	async createArchiveContext(file: TFile): Promise<ArchiveContext> {

		if (!(file instanceof TFile)) {
			throw new Error("Not a file");
		}
		if (!isChatFile(this.app, file)){
			throw new Error("File is not a ChatNote");
		}
	
		const source = await this.app.vault.read(file);
		const [messages, pinnedMessagecount] = parseMessages(source);

		const context = new ArchiveContext(
			file,
			messages,
			pinnedMessagecount
		);

		// the message-derived fields are filled in by the constructor; these come from
		// the config instead, so they'd otherwise stay at their defaults until the first
		// YAML change
		this.applyConfigToContext(context, this.getConfigCache(file));

		return context;
	}

	async onload() {
		
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Chat');

		// load global settings
		await this.loadSettings();

		this.addCommand({
			id: "create-chat-note",
			name: "Create new chat note",
			callback: () => {
				void this.createChatNote().catch(err => {
					console.error("Failed to create chat note", err);
					new Notice("Could not create the chat note");
				});
			},
		});

		this.updateRibbonIcon();

		this.addCommand({
			id: "focus-chat-input",
			name: "Focus chat input",
			checkCallback: (checking) => {
				const canFocus = !!this.currentFile && this.getIsChatNote(this.currentFile);
				if (canFocus && !checking) {
					this.chatTextareaEl?.focus();
				}
				return canFocus;
			},
			hotkeys: [{ modifiers: ["Mod"], key: "m" }],
		});

		this.addCommand({
			id: "scroll-to-bottom",
			name: "Scroll to Bottom",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				const canRun = !!view?.file && this.getIsChatNote(view.file);
				if (canRun && !checking) {
					scrollDocument(view!, "bottom");
				}
				return canRun;
			},
			hotkeys: [{ modifiers: ["Mod"], key: "ArrowDown" }],
		});

		this.addCommand({
			id: "scroll-to-top",
			name: "Scroll to Top",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				const canRun = !!view?.file && this.getIsChatNote(view.file);
				if (canRun && !checking) {
					scrollDocument(view!, "top");
				}
				return canRun;
			},
			hotkeys: [{ modifiers: ["Mod"], key: "ArrowUp" }],
		});
		
		this.addSettingTab(new ChatNotesSettingTab(this.app, this));

		document.addEventListener("click", (event) => {
			// on CLICK ANYWHERE
			/* Detect clicks outside a message action menu and closes the current open menu */

			if (!this.openMenu) return;
			const target = event.target as HTMLElement;
	
			if (!this.openMenu.contains(target)) {
				this.openMenu.classList.remove("menu-open");
				this.openMenu = null;
			}
		});

		this.registerEvent(
			// on FILE SWITCH
			/* Detect file switches and update chat input position */

				this.app.workspace.on("active-leaf-change", async (leaf) => {
					if (!leaf) return;
					const view = leaf.view;
					if (!(view instanceof MarkdownView)) return;
					const file = view?.file;
					if (!file) return;

					this.updateFileConfig(file);
					await this.onFileSwitch(file, view);
				})
		  );

		window.addEventListener("resize", () => {
			// on WINDOW RESIZE
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) return;
			this.updateChatInputPosition(view);

		});
		
		this.registerEvent(
			// on METADATA FILE CHANGES
			/* Detect yaml changes and refresh/rerender the file if the settings are overridden or if chat state is changed */

			this.app.metadataCache.on("changed", (file) => {
				void this.onYAMLChange(file).catch(err => {
					console.error("Failed to handle YAML change", err);
				});
			})
		);

		this.registerEvent(
			// TODO check if needed?
			this.app.vault.on("modify", (file) => {
			  this.updateFileConfig(file);
			})
		);

		// this is the main loop to discover, create and render Messages
		this.registerMarkdownCodeBlockProcessor(
			"chat-message",
			async (source, el, ctx) => {
				
				const file = ctx.sourcePath
				? this.app.vault.getAbstractFileByPath(ctx.sourcePath)
				: null;
				if (!(file instanceof TFile)) return;

				// Only render if the file has type: chat in yaml properties
				if (!this.getIsChatNote(file)) {
					// for now fallback render for non chat notes.
					// TODO remove render completely and display default code block

					const fallback = document.createElement("pre");
					const code = document.createElement("code");
				
					code.addClass("language-chat-message");
					code.textContent = source;
				
					fallback.appendChild(code);
					el.appendChild(fallback);

					return;
				}

				const context = await this.getArchiveContext(file);
				const id = extractMessageIdFromSource(source);
				const entry = context.messageMap.get(id);		// get the context entry for this message
				if (!entry) throw new Error("Error, message entry not found in archiveContext");
				const msg = entry.message
				const note = this.getChatNote(file);
				const config = this.getConfigCache(file);

				// Create HTML structure for message
				const {wrapper, content, row} = createElementsHTML({
					plugin: this,
					ctx,
					msg,
					author_text: msg.header.author ?? config.author,
					context,
					isReplyTarget: note.replyTo === msg.header.id,
					onToggle: this.handleMenuToggle.bind(this),				// callback for toggling the action menu
					onHighlight: this.handleMessagePin.bind(this),		// callback for the highlight/pin button
					onReplyToggle: this.handleReplyToggle.bind(this),		// callback for the hover reply button
					onScrollToReply: (targetId: string) => { void this.scrollToMessage(file, targetId); }	// callback for the reply banner
				});

				if (context.filterPinnedOnly) {
					const pinned = entry.message.header.extra.pinned === "true";
					wrapper.classList.toggle(
						"hidden-by-pin-filter",
						!pinned
					);
				}
				
				// attach message to file html container (row wraps the bubble + reply button;
				// entry.element stays pointed at the bubble itself so pin/highlight/scroll
				// styling keeps targeting exactly what it did before)
				el.appendChild(row);
				entry.element = wrapper;


				
				// apply the config styles to all html containers of the file (cascades down to every individual message)
				// apply them only if a new config is present. Later rendered messages will still use the container variables set by earlier messages
				if (note.lastAppliedConfig !== note.configCache) {
					await this.applyConfigToFile(file);
					note.lastAppliedConfig = note.configCache;
				}

				// highlight message if its pinned
				if (entry.message.header.extra.pinned === "true") {
					this.applyMessageHighlightStyle(
						entry.element,
						this.getConfigCache(this.currentFile!),
						true
					)
				}

				// Render message content as markdown
				await MarkdownRenderer.render(
					this.app,
					msg.content,
					content,
					ctx.sourcePath,
					// eslint-disable-next-line obsidianmd/no-plugin-as-component
					this 
				);

			}
		);
		
		// create input field
		this.app.workspace.onLayoutReady(() => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view) {
			  	this.updateChatInputPosition(view);
			}
		  });
	}

	onunload() {
		this.chatInputEl?.remove();
	}

	/* Event Helper Methods */

	async onFileSwitch(newFile: TFile, view: MarkdownView) {

		console.log("FILE SWITCH ")		
		const input = this.getChatInput();

		// Save old file input
		if (this.currentFile && this.chatInputEl) {
			this.getChatNote(this.currentFile).inputCache = this.getInputValue();
		}

		// return if new file is not a chat file
		if (!newFile || !this.getIsChatNote(newFile)) {
			// eslint-disable-next-line obsidianmd/no-static-styles-assignment
			input.style.display = "none";
			this.resizeObserver?.disconnect();
			this.currentFile = null;
			void this.updateReplyBanner();
			return;
		}

		// restore new file input if present
		this.currentFile = newFile
		const saved = this.getChatNote(newFile).inputCache ?? "";
		this.setInputValue(saved);
		void this.updateReplyBanner();

		// add scroll buttons to the newly opened chat file
		addScrollButtons(view);
		addPinButton(view, this.showPinnedMessagesOnly.bind(this));

		// eslint-disable-next-line obsidianmd/no-static-styles-assignment
		input.style.display = "flex";
		if (input.parentElement !== view.contentEl) {
			// TODO check where to attach input field, depending on mode or calculate updates
			if (view.getMode() === "preview") {}
			view.contentEl.appendChild(input);
			 
		}

		// Watch for iternal widow resizes (and update chat input field position)
		this.setupResizeObserver(view);

	}

	async onYAMLChange(file: TFile){

		const cache = this.app.metadataCache.getFileCache(file);
		const newFrontmatter = cache?.frontmatter;
		const oldFrontmatter = this.getChatNote(file).yamlCache;

		// check if YAML was actually changed (event is also triggered by file writes)
		if (JSON.stringify(newFrontmatter) === JSON.stringify(oldFrontmatter))  return; 
		if (!newFrontmatter) return; // YAML was removed?
		if (!(file instanceof TFile)) return;
		this.getChatNote(file).yamlCache = newFrontmatter;

		console.log("metadata change")

		// safe new config metadata changes to cache
		this.updateFileConfig(file);
		
		const previousStatus = this.getChatNote(file).isChatNote;
		const currentStatus = isChatFile(this.app, file);
		this.getChatNote(file).isChatNote = currentStatus;

		if (currentStatus && (currentStatus === previousStatus)) {
			// chat file YAML was changed -> apply styles AND the non-style settings
			// (chat owner, default-author mode), which live on the archive context
			await this.applyConfigToFile(file);

		} else if (currentStatus !== previousStatus) {
			// chat status has changed -> rerender completly
			// TODO needs Async??
			
			setTimeout(() => {
				// delay until UI + markdown settle
				console.log("FULL RERENDER")		
				void this.refreshFile(file);

				// the Full rerender triggers the onFileSwitch, so updating input field position is done already
				// this.updateChatInputPosition(view); //<- not needed

			}, 300); // timeout 300ms prevents error in embed link plugin.
		}

	}

	setupResizeObserver(view: MarkdownView) {
		const el = view.contentEl;
		if (!el) return;
	  
		// Clean up previous observer if needed
		this.resizeObserver?.disconnect();
	  
		this.resizeObserver = new ResizeObserver(() => {
		  this.updateChatInputPosition(view);
		});
	  
		this.resizeObserver.observe(el);
	}

	updateChatInputPosition(view: MarkdownView) {
		// set/update the position and size of the message input field

		const input = this.getChatInput();
		const inner =
			view.containerEl.querySelector(".cm-contentContainer") ||
			view.containerEl.querySelector(".markdown-preview-sizer");
		if (!inner) return;

		const margin = 16;

		/* Message bubbles sit inset from the content area by the reply gutter on both
		   sides (see .chat-message), so the input takes that same inset on top of its own
		   margin - otherwise it spans the full content width and overhangs the visible
		   edge of every message it lines up under. Read off the DOM rather than repeated
		   as a literal, so it stays tied to the single --msg-reply-gutter that positions
		   the bubbles. An unset property parses to NaN, and means the bubbles aren't
		   inset either - hence falling back to no gutter rather than to a guessed width. */
		const gutter = parseFloat(
			getComputedStyle(inner).getPropertyValue("--msg-reply-gutter")
		) || 0;
		const inset = gutter + margin;

		/* User taste on top of that alignment: grows (or shrinks) the field around its own
		   centre, so it stays centred on the same axis as the bubbles instead of drifting
		   off to one side - hence half the offset coming back off the left edge. */
		const widthOffset = this.settings.inputWidthOffset;

		const rect = inner.getBoundingClientRect();
		const parentRect = view.contentEl.getBoundingClientRect();
		const offsetLeft = rect.left - parentRect.left;

		// a negative width is an invalid declaration the browser drops entirely, which
		// would strand the input at whatever width a wider pane last gave it
		input.style.width = `${Math.max(0, rect.width - inset * 2 + widthOffset)}px`;
		input.style.left = `${offsetLeft + inset - widthOffset / 2}px`;

	}

	refreshOpenFiles() {
		const openFiles = new Set<TFile>();
	
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView && leaf.view.file) {
				openFiles.add(leaf.view.file);
			}
		});
	
		for (const file of openFiles) {
			void this.refreshFile(file); 	// updateChatInputPosition is called inside 
		}
	}

	async refreshFile(file: TFile) {
		
		const leaves = this.app.workspace.getLeavesOfType("markdown");
	
		for (const leaf of leaves) {
			const view = leaf.view;
	
			if (!(view instanceof MarkdownView)) continue;
			if (view.file?.path !== file.path) continue;
	
			if (view.getMode() === "preview") {
				// preview = reading mode
				view.previewMode.rerender(true);
			} else {
				// editor in live preview (or source mode)
				type RebuildableLeaf = WorkspaceLeaf & {
					rebuildView: () => Promise<void>;
				};
				
				await (leaf as RebuildableLeaf).rebuildView();
			}

			this.updateChatInputPosition(view);
		}
	}

	/* Chat Note Creation */

	/* Mirrors the ribbon icon to the setting. addRibbonIcon has no counterpart to remove
	   one, so the element is kept and detached by hand - and only ever created once, since
	   a second call would leave a duplicate icon behind. */
	updateRibbonIcon() {
		const wanted = this.settings.showRibbonIcon;

		if (wanted && !this.ribbonIconEl) {
			this.ribbonIconEl = this.addRibbonIcon(
				"message-square-plus",
				"Create new chat note",
				() => {
					void this.createChatNote().catch(err => {
						console.error("Failed to create chat note", err);
						new Notice("Could not create the chat note");
					});
				}
			);
		} else if (!wanted && this.ribbonIconEl) {
			this.ribbonIconEl.remove();
			this.ribbonIconEl = null;
		}
	}

	/* The frontmatter a new chat note starts with. Only the keys nothing else can supply
	   are written live: `type` is what marks the file as a chat at all (see isChatFile),
	   and `author` - the chat owner - has no global setting to fall back on. The rest are
	   commented out on purpose. A key that is actually present overrides the global setting
	   permanently for that file, so writing them all out would freeze the note's appearance
	   at creation time and silently ignore every later change to the global settings.
	   Values shown are the current globals, so uncommenting one changes nothing until it is
	   edited. */
	buildChatNoteFrontmatter(): string {
		const s = this.settings;

		return [
			"---",
			"type: chat",
			"author: ",
			"# --- optional per-file overrides, uncomment to use ---",
			`# msgShowAuthor: ${s.showMessageAuthor}`,
			`# msgShowTime: ${s.showMessageTimestamp}`,
			`# msgDefaultAuthor: ${s.defaultAuthorMode}`,
			`# msgScrollOnSend: ${s.scrollOnSend}`,
			// quoted, or YAML reads the leading "#" of a hex color as a comment
			`# msgColor: "${s.messageBgColor}"`,
			`# msgPinColor: "${s.messageHighlightColor}"`,
			`# msgFlashColor: "${s.messageFlashColor}"`,
			`# msgReplyColor: "${s.messageReplyColor}"`,
			`# msgBorderColor: "${s.messageBorderColor}"`,
			"---",
			""
		].join("\n");
	}

	/* Creates a blank chat note and opens it. The input field and rendering follow on their
	   own: the note only becomes a chat once metadataCache has parsed the new frontmatter,
	   which fires onYAMLChange and takes the "chat status changed" path from there. */
	async createChatNote(): Promise<TFile> {

		// resolves against the user's own "Default location for new notes" preference
		// rather than hardcoding the vault root
		const parent = this.app.fileManager.getNewFileParent(
			this.app.workspace.getActiveFile()?.path ?? ""
		);
		const folder = parent.path === "/" ? "" : `${parent.path}/`;

		let path = normalizePath(`${folder}${NEW_CHAT_NOTE_NAME}.md`);
		for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) {
			path = normalizePath(`${folder}${NEW_CHAT_NOTE_NAME} ${n}.md`);
		}

		const file = await this.app.vault.create(path, this.buildChatNoteFrontmatter());
		await this.app.workspace.getLeaf(false).openFile(file);

		return file;
	}

	/* Message Actions */

	handleMenuToggle(menu: HTMLElement) {
		if (this.openMenu && this.openMenu !== menu) {
			this.openMenu.classList.remove("menu-open");
		}

		const isOpening = !menu.classList.contains("menu-open");
		menu.classList.toggle("menu-open");
		this.openMenu = isOpening ? menu : null;

	}

	async handleMessagePin(msgId: string, isPinned: boolean){

		if (!this.currentFile) throw new Error("Current file is not set");
		const config = this.getConfigCache(this.currentFile);
		const context = await this.getArchiveContext(this.currentFile);
		const entry = context.getEntry(msgId);
		const msg = entry.message

		const el = entry.element
		if (!el) throw new Error("Rendered element missing.");

		const pinState = !(msg.header.extra.pinned === "true")
		// message is now being unpinned
		this.applyMessageHighlightStyle(el, config, pinState);
		// update context
		msg.header.extra.pinned = `${pinState}`;
		await this.setMessageHeaderPinned(this.currentFile, entry, pinState);  // this triggers CBP

		if (pinState){
			context.pinnedMessagesAmount += 1
		} else {
			context.pinnedMessagesAmount -= 1
		}

	}

	async handleReplyToggle(msgId: string) {

		if (!this.currentFile) throw new Error("Current file is not set");
		const note = this.getChatNote(this.currentFile);
		const context = await this.getArchiveContext(this.currentFile);

		// clear the highlight on the previously targeted message, if any
		if (note.replyTo) {
			const previous = context.messageMap.get(note.replyTo);
			previous?.element?.classList.remove("chat-message-reply-target");
		}

		// clicking the same message again cancels the reply
		const wasSameTarget = note.replyTo === msgId;
		note.replyTo = wasSameTarget ? undefined : msgId;

		if (note.replyTo) {
			const entry = context.getEntry(note.replyTo);
			entry.element?.classList.add("chat-message-reply-target");
		}

		await this.updateReplyBanner();
	}

	/* Cancels the pending reply (if any) and reverts the input to a normal send,
	   used by both the input banner's cross button and after a message is sent. */
	async handleCancelReply() {

		if (!this.currentFile) return;
		const note = this.getChatNote(this.currentFile);
		if (!note.replyTo) return;

		const context = await this.getArchiveContext(this.currentFile);
		const previous = context.messageMap.get(note.replyTo);
		previous?.element?.classList.remove("chat-message-reply-target");

		note.replyTo = undefined;
		await this.updateReplyBanner();
	}

	/* Syncs the input's reply banner (shown/hidden + preview text) with the current
	   file's pending reply target. */
	async updateReplyBanner() {

		if (!this.chatReplyBannerEl || !this.chatReplyTextEl) return;

		if (!this.currentFile) {
			this.chatReplyBannerEl.classList.remove("is-visible");
			return;
		}

		const note = this.getChatNote(this.currentFile);
		if (!note.replyTo) {
			this.chatReplyBannerEl.classList.remove("is-visible");
			return;
		}

		const context = await this.getArchiveContext(this.currentFile);
		// bail if the reply was cancelled (or changed) while the context was loading
		if (this.getChatNote(this.currentFile).replyTo !== note.replyTo) return;

		const targetEntry = context.messageMap.get(note.replyTo);
		const author = targetEntry?.message.header.author || "Unknown";
		const preview = targetEntry?.message.content.trim().replace(/\s+/g, " ").slice(0, 80);

		this.chatReplyTextEl.textContent = preview ? `Replying to ${author}: ${preview}` : `Replying to ${author}`;
		this.chatReplyBannerEl.classList.add("is-visible");
	}

	handleOpenEditor(newEditor: {
		container: HTMLElement;
		restore: () => void;
	}) {

		// If same editor = do nothing
		if (this.activeEditor?.container === newEditor.container) {
			return;
		}
	
		// Close previous editor
		if (this.activeEditor) {
			this.activeEditor.restore();
		}
	
		this.activeEditor = newEditor;
	}
	
	clearActiveEditor(editor: { container: HTMLElement }) {
		if (this.activeEditor?.container === editor.container) {
			this.activeEditor = null;
		}

	}

	/* Builds a full message (header + content) and appends it to the file. `overrides`
	   carries whatever the user typed into the input's header row; anything left empty
	   there falls back to the configured default. */
	async appendMessage(file: TFile, content: string, overrides?: {
		author?: string;
		timestamp?: string;
	}) {
		const context = await this.getArchiveContext(file);
		const note = this.getChatNote(file);

		const extra: Record<string, string> = {};
		if (note.replyTo) {
			extra.reply_to = note.replyTo;		// key the renderer already reads
		}

		const header = new Header(
			context.nextMessageId(),
			overrides?.author || context.resolveDefaultAuthor(),
			overrides?.timestamp || formatTimestamp(),
			extra
		);

		const message = Message.create(header, content);
		const raw = message.toString();

		const data = await this.app.vault.read(file);
		// guarantee the block opens on its own line, whatever the file happened to end with
		const prefix = data.endsWith("\n") ? data : data + "\n";

		const startLine = prefix.split("\n").length - 1;
		const blockLines = raw.split("\n");

		// registered before the write, not after: modify() makes the codeblock processor
		// rerun, and it throws if the context has no entry for the block it's rendering
		context.addMessage({
			id: header.id,
			message,
			startLine,
			// lastIndexOf, so a "````" line inside the content can't be mistaken for the
			// closing fence - the real one is always last
			endLine: startLine + blockLines.lastIndexOf("````")
		});

		await this.app.vault.modify(file, prefix + raw);
	}

	/* Jump to the end of the chat after a message was sent (the "Scroll to bottom on send"
	   setting). A single jump would land at the document's *old* bottom: vault.modify only
	   schedules the codeblock processor, so at this point the new message has neither been
	   rendered nor added its height. Waiting for it to render first is not the answer
	   either - both view modes only render near the viewport, so a message appended below
	   the fold renders *because* something scrolled to it, and waiting on it before
	   scrolling just stalls until the timeout.

	   So this scrolls immediately and keeps re-scrolling for a short window instead: the
	   first jump is instant feedback, and each one drags the render (and the growth it
	   brings) along until the document stops moving. */
	scrollToBottomAfterSend(file: TFile) {

		const view = this.app.workspace.getLeavesOfType("markdown")
			.map(leaf => leaf.view)
			.find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === file.path);
		if (!view) return;

		const start = performance.now();

		const pin = () => {
			scrollDocument(view, "bottom");
			// short enough that it can't fight the user for long if they scroll away
			// mid-window, long enough to outlast the render of an ordinary message
			if (performance.now() - start < SCROLL_ON_SEND_PIN_MS) {
				requestAnimationFrame(pin);
			}
		};

		pin();
	}

	async showPinnedMessagesOnly(){
		const context = await this.getArchiveContext(this.currentFile!);
		context.updateVisibility();
	}

	async scrollToMessage(file: TFile, msgId: string, options?: {
		behavior?: ScrollBehavior;
		block?: ScrollLogicalPosition;
		highlight?: boolean;
	}) {
		const context = await this.getArchiveContext(file);
		const entry = context.getEntry(msgId);

		// Reading View and Live Preview both only render messages near the current
		// scroll position (CodeMirror unmounts far-off widgets entirely, and Reading
		// View lazily renders long notes in sections) - entry.element is undefined, or
		// still points at an old detached node, for any message that hasn't been
		// rendered/re-rendered since it last scrolled into view. Force Obsidian to jump
		// to its source line first (which mounts it via our codeblock processor), then
		// wait for that render to land before doing the precise scroll + highlight.
		if (!entry.element || !entry.element.isConnected) {
			const view = this.app.workspace.getLeavesOfType("markdown")
				.map(leaf => leaf.view)
				.find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === file.path);

			if (view) {
				view.setEphemeralState({ line: entry.startLine });
				await this.waitForRenderedElement(entry);
			}
		}

		if (!entry.element) return false;

		entry.element.scrollIntoView({
			behavior: options?.behavior ?? "smooth",
			block: options?.block ?? "center",
			inline: "nearest",
		});

		// wait until scrolling has finished and then play the highlight animation
		await this.waitUntilVisible(entry.element);

		if (options?.highlight ?? true) {
			entry.element.classList.add("chat-message-scroll-highlight");
			setTimeout(() => {
				if (entry.element) {
					entry.element.classList.remove("chat-message-scroll-highlight");
				}
			}, 900);
		}

		return true;
	}

	/* Polls (via rAF) until the codeblock processor has (re)rendered this entry's
	   element into the live DOM, or gives up after timeoutMs so callers never hang. */
	async waitForRenderedElement(entry: MessageEntry, timeoutMs = 1500): Promise<void> {
		const start = performance.now();

		while (!entry.element || !entry.element.isConnected) {
			if (performance.now() - start > timeoutMs) return;
			await new Promise(resolve => requestAnimationFrame(resolve));
		}
	}

	async waitUntilVisible(
		element: HTMLElement,
		container: HTMLElement | Window = window,
		margin = 20,
		timeoutMs = 1500
	): Promise<void> {
		return new Promise(resolve => {
			const start = performance.now();

			const check = () => {
				const rect = element.getBoundingClientRect();

				// Overlap-based (not full-containment) so this also resolves for messages
				// taller than the viewport, which full containment could never satisfy -
				// scrollIntoView({block: "center"}) already centers as best it can there.
				let visible: boolean;

				if (container === window) {
					visible =
						rect.top <= window.innerHeight - margin &&
						rect.bottom >= margin;
				} else {
					const cRect = (container as HTMLElement).getBoundingClientRect();
					visible =
						rect.top <= cRect.bottom - margin &&
						rect.bottom >= cRect.top + margin;
				}

				if (visible || performance.now() - start > timeoutMs) {
					resolve();
				} else {
					requestAnimationFrame(check);
				}
			};

			check();
		});
	}

	/* Settings & Config */

	async loadSettings() {
		const data = (await this.loadData()) as Partial<ChatNotesPluginSettings> ?? {};
		
		this.settings = {
			...DEFAULT_SETTINGS,
			...data,
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);

		this.updateRibbonIcon();
		this.updateAllFileConfigs();
		this.refreshOpenFiles();
	}

	updateAllFileConfigs() {
		for (const file of this.app.vault.getMarkdownFiles()) {
			this.updateFileConfig(file);
		}
	}

	updateFileConfig(file: TAbstractFile) {
		// update and store config cache for a file
		if (!(file instanceof TFile)) return;
		const overrides = getFileOverrides(this.app, file);
		const resolved = resolveConfig(this.settings, overrides);
		this.getChatNote(file).configCache = resolved;
		return resolved;
	}

	/* Styling */

	async applyStyles(container: HTMLElement, config: ChatConfig, context: ArchiveContext) {

		// console.log(container)
		if (config.messageBgColor) {
			container.style.setProperty(
				"--settings-msg-bg-color",
				config.messageBgColor
			);
			// the header's author button and the action-menu icons sit directly on the
			// bubble, so they follow the same contrast pick as the reply banner instead
			// of Obsidian's theme text color - which an extreme bubble color can leave
			// nearly invisible (see .msg-author / .msg-action-btn)
			container.style.setProperty(
				"--settings-msg-text-color",
				getReadableTextColor(config.messageBgColor)
			);
		}
	  
		container.style.setProperty(
		  "--settings-msg-corner-radius",
		  `${config.messageCornerRadius}px`
		);

		// the input field intentionally stays rounder ("pill" shaped) than the message
		// bubbles, but tracks the same setting with a fixed offset so both scale together.
		// Named --chat-input-radius (not --input-radius) since Obsidian's own theme
		// already defines --input-radius globally for every native input/button.
		container.style.setProperty(
			"--chat-input-radius",
			`${(config.messageCornerRadius ?? 12) + 8}px`
		);

		if (config.enableButtonShadow) {
			container.classList.remove("menu-btn-no-shadow");
		} else {
			container.classList.add("menu-btn-no-shadow");
		}

		// hidden by a class on the container rather than by skipping the buttons when the
		// header is built: this path reruns on every settings/YAML change, so both toggles
		// take effect on the messages already on screen instead of needing a rerender
		container.classList.toggle("msg-header-no-author", config.showMessageAuthor === false);
		container.classList.toggle("msg-header-no-timestamp", config.showMessageTimestamp === false);

		if (config.messageFlashColor){
			container.style.setProperty(
				"--settings-msg-flash-color",
				config.messageFlashColor
			);
		}

		if (config.messageReplyColor){
			container.style.setProperty(
				"--settings-msg-reply-color",
				config.messageReplyColor
			);
			container.style.setProperty(
				"--settings-msg-reply-text-color",
				getReadableTextColor(config.messageReplyColor)
			);
		}

		if (config.messageBorderColor){
			container.style.setProperty(
				"--settings-msg-border-color",
				config.messageBorderColor
			);
		}

		if (context.pinnedMessagesAmount > 0){
			context.refreshStylesPerMessage(config);
		}
	}

	/* The config that isn't CSS. applyStyles pushes the visual settings onto the DOM
	   container and lets them cascade; these are plain values the message-building code
	   reads instead, so they need their own path onto the context. */
	applyConfigToContext(context: ArchiveContext, config: ChatConfig) {
		context.chatAuthor = config.author;
		context.defaultAuthorMode = config.defaultAuthorMode ?? "owner";
	}

	applyMessageHighlightStyle(msg: HTMLElement, config: ChatConfig, isPinned: boolean){
		// override the background color for highlighted Messages

		const color = isPinned
			? config.messageHighlightColor
			: config.messageBgColor;

		if (!color) return;

		msg.style.setProperty(
			"--settings-msg-bg-color",
			color
		);
		// pinned messages override the bubble color on the element itself, so the header's
		// contrast pick has to be re-made against *this* background - the container-level
		// one applyStyles set is for the normal bubble color and would be the wrong choice
		// whenever the two colors differ in brightness
		msg.style.setProperty(
			"--settings-msg-text-color",
			getReadableTextColor(color)
		);
	}

	async applyConfigToFile(file: TFile){
		// push the file's current config to its archive context (non-CSS settings) and to
		// every html container it's open in (the CSS variables)

		console.log("applying config to file")
		const config = this.getConfigCache(file);
		const context = await this.getArchiveContext(file);

		// before the container check on purpose: the context still needs the new config
		// even when the file isn't open in any view right now
		this.applyConfigToContext(context, config);

		const allContainers = getActiveContainers(this.app, file)
		if (!allContainers) return;

		for (const fileContainers of allContainers) {
			for (const container of fileContainers) {
					await this.applyStyles(container, config, context);
			}
		}

	}

	/* Helper Methods */

	getChatInput(): HTMLElement {
		if (!this.chatInputEl) {
			const result = createChatInput(this);
			this.chatInputEl = result.container;
			this.chatTextareaEl = result.textarea;
			this.chatReplyBannerEl = result.replyBanner;
			this.chatReplyTextEl = result.replyText;
		}

		return this.chatInputEl;
	}

	getInputValue(): string {
		//TODO return if not initialized?
		const input = this.chatInputEl.querySelector("textarea, input");
		return input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement
			? input.value
			: "";
	}
	
	setInputValue(value: string) {
		//TODO lazy initialize? -> need to get view
		const input = this.chatInputEl.querySelector("textarea, input");
		if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
			input.value = value;
			// resize the textarea to fit the restored content
			input.dispatchEvent(new Event("input"));
		}
	}

    getChatNote(file: TFile): ChatNote {
		// returns the existing ChatNote or creates a new empty one

        let note = this.chatNotes.get(file);

        if (!note) {
            note = new ChatNote(file);
            this.chatNotes.set(file, note);
        }

        return note;
    }

	getConfigCache(file: TFile){
		// helper method to avoid checking if configCash is undefined or not
		let config = this.getChatNote(file).configCache;
		if (config === undefined){
			config = this.updateFileConfig(file);
			this.getChatNote(file).configCache = config;
			if (config === undefined) {
				throw Error("unexpected Error: File could not update config. File might not be a TFile")
			} 
		}
		return config;
	}

	getIsChatNote(file: TFile): boolean {
		const note = this.getChatNote(file);

		if (note.isChatNote === undefined){
			note.isChatNote = isChatFile(this.app, file);
		}

		return note.isChatNote;
	}

	async getArchiveContext(file: TFile): Promise<ArchiveContext> {

 		// promise because CBP works asynchronously, otherwise it will calculate it for multiple messages
		let contextPromise = this.archiveContexts.get(file.path);
		if (!contextPromise) {
			// lazy context initialization
			// -> scan the whole file and establish context
			console.log("generating context:", file.path);
			contextPromise = this.createArchiveContext(file);
			this.archiveContexts.set(
				file.path,
				contextPromise
			);
		}

		return contextPromise;
	}

	async setMessageHeaderPinned(file: TFile, entry: MessageEntry, pinned: boolean) {

		const content = await this.app.vault.read(file);
		const lines = content.split("\n");
		const start = entry.startLine;

		const headerEnd = lines.indexOf(
			"~~~",
			start + 1
		);

		const headerLines = lines.slice(start, headerEnd);
		const pinnedLine = headerLines.findIndex(
			line => line.startsWith("pinned:")
		);
	
		if (pinnedLine !== -1) {
			lines[start + pinnedLine] =
				`pinned: ${pinned}`;
		} else {
			// add it before ~~~
			lines.splice(
				headerEnd,
				0,
				`pinned: ${pinned}`
			);
		}
	
		// this will trigger the CodeBlockProcessor to rerun
		await this.app.vault.modify(
			file,
			lines.join("\n")
		);
	}
}

