import { Plugin, MarkdownRenderer, MarkdownRenderChild, TFile, MarkdownView, WorkspaceLeaf, TAbstractFile, Notice, normalizePath, setTooltip } from "obsidian";
import { Header, Message, ChatNote, ArchiveContext } from "./types";
import { DEFAULT_SETTINGS, ChatNotesPluginSettings, ChatNotesSettingTab, ChatConfig, getFileOverrides, resolveConfig, OVERRIDE_KEYS } from "./settings";
import { createElementsHTML, addScrollButtons, createChatInput, addPinButton, addSearchButton, removeChatViewActions, updateReactionBar } from "./ui";
import { createSearchBar } from "./search-bar";
import { parseSearchQuery, messageMatches, isFilteredOut, MessageFilter, collectSuggestionValues, SuggestionValues } from "./search";
import { createFilterExtension } from "./filter-extension";
import { refreshSticky } from "./sticky";
import { isChatFile, scrollDocument, extractMessageIdFromSource, parseMessages, renumberMessageIds, getActiveContainers, getEmbedHosts, embedHostOf, getRenderedChatPaths, getReadableTextColor, formatTimestamp, findMessageRows, collectMessageRows, isRowRendered, rowScroller, setHeaderField } from "./util";
import { Reaction, ReactionChange, REACTIONS_KEY, readReactions, addReaction, removeReaction, serializeReactions } from "./reactions";
import { EmojiPicker, openEmojiPicker } from "./emoji-picker";
import { ConfirmModal } from "./modals"

const NEW_CHAT_NOTE_NAME = "Untitled chat";

// what a chat-message block renders as when it can't be shown as a message: in a note that
// isn't a chat, or while the block is still being typed and doesn't parse yet
function renderFallbackBlock(el: HTMLElement, source: string) {
	const fallback = createEl("pre");
	const code = createEl("code");

	code.addClass("language-chat-message");
	code.textContent = source;

	fallback.appendChild(code);
	el.appendChild(fallback);
}

// how long holdScroll keeps re-applying a scroll position
const SCROLL_HOLD_MS = 500;

function blockKey(file: TFile, msgId: string): string {
	return `${file.path}\n${msgId}`;
}

/* A row re-created under the pointer isn't :hover until the pointer moves again, so its
   author badge and reply button would swap back for a moment. The class stands in for
   :hover until then. */
function carryHover(row: HTMLElement) {
	row.classList.add("is-hover-carried");
	row.doc.addEventListener("pointermove", () => row.classList.remove("is-hover-carried"), { once: true });
}

/* The element the chat input's geometry is measured from, per view mode. Obsidian keeps BOTH
   subviews mounted and hides the inactive one, so both of these exist at once - which is what
   lets setupResizeObserver watch the pair without re-targeting on a mode switch. */
const INPUT_SIZER_SELECTORS = {
	preview: ".markdown-reading-view .markdown-preview-sizer",
	source: ".markdown-source-view .cm-contentContainer"
} as const;

export default class ChatNotesPlugin extends Plugin {

	openMenu: HTMLElement | null = null;
	private emojiPicker: EmojiPicker | null = null;
	settings: ChatNotesPluginSettings;
	chatInputEl: HTMLElement;
	chatTextareaEl: HTMLTextAreaElement;
	chatReplyBannerEl: HTMLElement;
	chatReplyTextEl: HTMLElement;
	resizeObserver: ResizeObserver | null = null;
	// releases the migration hook the observer is re-registered by (see setupResizeObserver)
	private windowMigration: (() => void) | null = null;
	currentFile: TFile | null = null;
	ribbonIconEl: HTMLElement | null = null;
	chatInputTeardown: (() => void) | null = null;

	// the one search bar, built lazily and moved between views like the chat input
	private searchBar: ReturnType<typeof createSearchBar> | null = null;
	// the file the search bar is mounted for - not currentFile, since the search button of a
	// background pane opens it there
	private searchFile: TFile | null = null;

	// collapses filtered-out messages in Live Preview (see filter-extension.ts)
	private filterExtension = createFilterExtension(file => this.getMessageFilter(file));

	private chatNotes = new WeakMap<TFile, ChatNote>();			// holds metadata and cache of the files
	private archiveContexts = new Map<string, Promise<ArchiveContext>>();	// holds messages/content of the files

	// rows currently flagged as a reply target, with the file they belong to (see markReplyTarget)
	private replyTargetRows = new Map<HTMLElement, TFile>();

	// every rendered row, with what it was rendered from, including rows the view keeps
	// detached (see syncSearchRows); dropped when the row's render child unloads
	private chatRows = new Map<HTMLElement, { file: TFile; message: Message }>();

	// the config each embed host was last styled with (see styleEmbedHost)
	private styledEmbeds = new WeakMap<HTMLElement, ChatConfig>();

	// state of a block just rewritten in the editor, by blockKey (see reserveBlock)
	private reservedBlocks = new Map<string, { height: number; hovered: boolean }>();

	/* Timers the plugin can take back: Obsidian reclaims none of them, and a callback that lands
	   after onunload runs against a plugin that is gone. */
	private timeouts = new Set<number>();
	// closures, not frame ids: these are scheduled in the view's own window, and frame ids
	// are per window
	private cancelScrollHold: (() => void) | null = null;
	private cancelResizeFrame: (() => void) | null = null;

	activeEditor: {
		container: HTMLElement;
		restore: () => void;
	} | null = null;


	/* `source` is passed in when the caller already has the file's current text (the metadata
	   change event hands it over), which saves a read. Otherwise cachedRead: this only parses
	   for display, and Obsidian keeps that cache in step with the vault. */
	async createArchiveContext(file: TFile, source?: string): Promise<ArchiveContext> {

		if (!(file instanceof TFile)) {
			throw new Error("Not a file");
		}
		if (!isChatFile(this.app, file)){
			throw new Error("File is not a ChatNote");
		}

		const text = source ?? await this.app.vault.cachedRead(file);
		const [messages, , duplicateIds] = parseMessages(text);

		/* Reported from the first parse of a file only, not from invalidateArchiveContext:
		   that one runs on every save, and a block being typed passes through states where its
		   id repeats an existing one. */
		if (duplicateIds.length > 0) {
			new Notice(
				`${file.basename}: ${String(duplicateIds.length)} duplicate message id(s). Run "Recalculate message ids" to fix.`
			);
		}

		const context = new ArchiveContext(
			file,
			messages
		);

		// the message-derived fields come from the constructor; these come from the config
		this.applyConfigToContext(context, this.getConfigCache(file));

		return context;
	}

	async onload() {

		await this.loadSettings();

		this.registerEditorExtension(this.filterExtension.extension);

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
		});

		/* No default hotkeys on any of these: Obsidian's guidelines call them out as a source
		   of conflicts with other plugins and with bindings the user already set. */
		this.addCommand({
			id: "scroll-to-bottom",
			name: "Scroll to bottom",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				const canRun = !!view?.file && this.getIsChatNote(view.file);
				if (canRun && !checking) {
					scrollDocument(view, "bottom");
				}
				return canRun;
			},
		});

		this.addCommand({
			id: "scroll-to-top",
			name: "Scroll to top",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				const canRun = !!view?.file && this.getIsChatNote(view.file);
				if (canRun && !checking) {
					scrollDocument(view, "top");
				}
				return canRun;
			},
		});

		this.addCommand({
			id: "search-chat-note",
			name: "Search messages",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				const canRun = !!view?.file && this.getIsChatNote(view.file);
				if (canRun && !checking) {
					this.openSearch(view);
				}
				return canRun;
			},
		});

		this.addCommand({
			id: "recalculate-message-ids",
			name: "Recalculate message ids",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				const file = view?.file;
				const canRun = !!file && this.getIsChatNote(file);

				if (canRun && !checking) {
					new ConfirmModal(this.app, {
						title: "Recalculate message ids?",
						body: "Every message in this note is renumbered from 1, in order, and reply links are rewritten to match. A reply whose message no longer exists loses its link. This can be undone with the editor's undo.",
						confirmText: "Recalculate"
					}, () => {
						void this.recalculateMessageIds(file).catch(err => {
							console.error("Failed to recalculate message ids", err);
							new Notice("Could not recalculate the message ids");
						});
					}).open();
				}

				return canRun;
			},
		});

		this.addCommand({
			id: "add-override-properties",
			name: "Add override properties",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				const file = view?.file;
				const canRun = !!file && this.getIsChatNote(file);

				if (canRun && !checking) {
					void this.addOverrideProperties(file).catch(err => {
						console.error("Failed to add override properties", err);
						new Notice("Could not add the override properties");
					});
				}

				return canRun;
			},
		});

		this.addSettingTab(new ChatNotesSettingTab(this.app, this));

		// on CLICK ANYWHERE: close the open message action menu
		this.registerDomEvent(document, "click", (event) => {
			if (!this.openMenu) return;
			const target = event.target as HTMLElement;

			if (!this.openMenu.contains(target)) this.closeMenu();
		});

		/* on FILE SWITCH: move the chat input to the view showing the file, and swap the draft
		   it holds for that file's own.

		   Neither event covers the other: "active-leaf-change" catches a move to another leaf
		   showing the SAME file, "file-open" catches a new file inside the same leaf (and the
		   file already open at load). Both firing for one switch is harmless - every step of
		   onFileSwitch is idempotent. */
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.handleFileSwitch()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.handleFileSwitch()));

		// workspace "resize" rather than window "resize": it also fires for sidebar and
		// split changes, which resize the pane without resizing the window
		this.registerEvent(
			this.app.workspace.on("resize", () => this.repositionActiveChatInput())
		);

		/* The only event that fires on a reading <-> live preview switch, or when a view is
		   rebuilt in place: the leaf never changes, so active-leaf-change doesn't fire, and
		   contentEl keeps its size, so the ResizeObserver doesn't either. */
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				// a rebuilt view keeps its element but not necessarily our class on it
				this.syncChatViews();
				this.repositionActiveChatInput();
			})
		);

		/* on METADATA CHANGE: the file's text changed, so the parsed model is stale. This
		   event carries the new content, so the rebuild costs a parse and no read. Model
		   first, then the existing config/status handling - onYAMLChange reaches for the
		   context and must not get the superseded one. */
		this.registerEvent(
			this.app.metadataCache.on("changed", (file, data) => {
				this.invalidateArchiveContext(file, data);

				void this.onYAMLChange(file).catch(err => {
					console.error("Failed to handle YAML change", err);
				});
			})
		);

		// a file the plugin has no context for can't go stale, and a renamed one is looked
		// up by its new path - so both are just a drop
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.archiveContexts.delete(oldPath);
				this.archiveContexts.delete(file.path);
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.archiveContexts.delete(file.path);
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

				// Only render if the file has type: chat-note in yaml properties
				if (!this.getIsChatNote(file)) {
					renderFallbackBlock(el, source);
					return;
				}

				// before the first await, so the empty block never paints at zero height
				const reserved = this.getReservedBlock(file, source);
				if (reserved) {
					el.style.setProperty("--chat-reserved-height", `${reserved.height}px`);
					el.classList.add("chat-block-reserved");
				}

				const context = await this.getArchiveContext(file);
				const note = this.getChatNote(file);
				const config = this.getConfigCache(file);

				/* A message the parse hasn't seen yet - typed by hand, pasted, or appended a
				   moment ago - is read straight from `source` rather than forcing a reparse.
				   Live Preview re-runs this callback on every keystroke while a block is being
				   typed, so an unknown id must not throw. */
				let msg: Message;
				try {
					const id = extractMessageIdFromSource(source);
					const known = context.messageMap.get(id);

					if (known) {
						msg = known.message;
					} else {
						msg = Message.fromString(source);

						// register it so the author dropdown, next-id and reply lookups
						// account for it before the reparse lands
						const section = ctx.getSectionInfo(el);
						context.addMessage({
							id,
							message: msg,
							startLine: section?.lineStart ?? 0,
							endLine: section?.lineEnd ?? 0
						});
					}
				} catch (e) {
					// a half-typed or malformed block - show it as a plain code block rather
					// than throwing inside a render callback
					console.warn("Could not read chat message block", e);
					el.classList.remove("chat-block-reserved");
					renderFallbackBlock(el, source);
					return;
				}

				const {content, row} = createElementsHTML({
					plugin: this,
					ctx,
					msg,
					author_text: msg.header.author ?? config.author,
					context,
					// every callback closes over THIS file, so a click in a background leaf
					// acts on the message it belongs to rather than on whatever is focused
					onToggle: this.handleMenuToggle.bind(this),				// callback for toggling the action menu
					onPin: (targetId: string) => { void this.handleMessagePin(file, targetId); },
					onReaction: (targetId: string, change: ReactionChange, emoji: string) => { void this.handleReaction(file, targetId, change, emoji); },
					onReactionPicker: (targetId: string, anchor: HTMLElement) => this.toggleEmojiPicker(file, targetId, anchor),
					onReplyToggle: (targetId: string) => { void this.handleReplyToggle(file, targetId); },
					syncReplyTarget: (row: HTMLElement, targetId: string) => this.syncRowReplyTarget(file, row, targetId),
					syncSearch: (row: HTMLElement, rowMsg: Message) => this.syncRowSearch(file, row, rowMsg),
					// callback for the reply banner; `origin` is the row it was clicked in
					onScrollToReply: (targetId: string, origin: HTMLElement) => { void this.scrollToMessage(file, targetId, { origin }); }
				});

				// nothing to do for the pinned-only filter here: the row carries data-pinned
				// and the container carries the filter class, so CSS covers it on mount
				if (reserved?.hovered) carryHover(row);
				el.appendChild(row);
				this.chatRows.set(row, { file, message: msg });

				// not once: Live Preview re-inserts cached rows, which may be the first sign of
				// an embed opened since the config last changed
				row.onNodeInserted(() => this.styleEmbedHost(file, row));


				// only when the config actually changed - every later message inherits the
				// container properties the first one applied
				if (note.lastAppliedConfig !== note.configCache) {
					await this.applyConfigToFile(file);
					note.lastAppliedConfig = note.configCache;
				}

				/* Rendered under a child bound to THIS block, not under the plugin: anything
				   the markdown mounts (embeds, other plugins' processors) then unloads when
				   the block does, instead of living until the plugin unloads. */
				const renderChild = new MarkdownRenderChild(content);
				ctx.addChild(renderChild);

				// the block is gone for good, so a search can stop tracking its row
				renderChild.register(() => { this.chatRows.delete(row); });

				await MarkdownRenderer.render(
					this.app,
					msg.content,
					content,
					ctx.sourcePath,
					renderChild
				);
				el.classList.remove("chat-block-reserved");

			}
		);

		/* The file already open at load: its own file-open may have fired before the listener
		   above existed, so run the switch by hand. Without it currentFile stays null, and the
		   input's draft cache is gated on it. */
		this.app.workspace.onLayoutReady(() => this.handleFileSwitch());
	}

	/* Obsidian reclaims none of this by itself: an element removed while focused fires no
	   blur (so the input's keymap scope would stay pushed and go on swallowing Mod+Enter),
	   and view actions and the container class live on views the plugin doesn't own. */
	onunload() {
		this.closeMenu();
		this.chatInputTeardown?.();
		this.resizeObserver?.disconnect();
		this.windowMigration?.();
		this.chatInputEl?.remove();
		this.searchBar?.teardown();
		this.searchBar?.container.parentElement?.classList.remove("chat-search-open");
		this.searchBar?.container.remove();
		this.chatRows.clear();

		for (const id of this.timeouts) window.clearTimeout(id);
		this.timeouts.clear();
		this.cancelScrollHold?.();
		this.cancelResizeFrame?.();

		this.forEachMarkdownView(view => {
			view.contentEl.classList.remove("chat-note-view");
			removeChatViewActions(view);
		});
	}

	forEachMarkdownView(fn: (view: MarkdownView) => void) {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (leaf.view instanceof MarkdownView) fn(leaf.view);
		}
	}

	/* Marks the views currently showing a chat note, and strips the ones that aren't.
	   `chat-note-view` scopes every rule in styles.css that reaches Obsidian's own note
	   elements - unscoped they would restyle every note in the vault. The view actions share
	   that lifetime: a tab that navigates away from a chat note keeps neither. */
	syncChatViews() {
		this.forEachMarkdownView(view => {
			const file = view.file;
			const isChat = !!file && this.getIsChatNote(file);

			view.contentEl.classList.toggle("chat-note-view", isChat);
			if (!isChat) removeChatViewActions(view);
		});
	}

	/* Event Helper Methods */

	/* Everything a view needs when the file it shows changes - or when the file stops or starts
	   being a chat note under it, which is the same problem. A method rather than a listener
	   closure because refreshFile has to run it by hand: see there. */
	handleFileSwitch() {
		// every open view, not just the active one: a background split can be showing a
		// chat note too, and the one being left has to give its chat dressing back
		this.syncChatViews();

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file;
		if (!view || !file) return;

		this.updateFileConfig(file);
		void this.onFileSwitch(file, view).catch(err => {
			console.error("Failed to switch chat file", err);
		});
	}

	async onFileSwitch(newFile: TFile, view: MarkdownView) {

		const input = this.getChatInput();

		// Save old file input
		if (this.currentFile) {
			this.getChatNote(this.currentFile).inputCache = this.getInputValue();
		}

		if (!newFile || !this.getIsChatNote(newFile)) {
			input.setCssStyles({ display: "none" });
			this.resizeObserver?.disconnect();
			this.currentFile = null;
			this.syncSearchBar(null);
			void this.updateReplyBanner();
			return;
		}

		// restore new file input if present
		this.currentFile = newFile
		const saved = this.getChatNote(newFile).inputCache ?? "";
		this.setInputValue(saved);
		void this.updateReplyBanner();

		/* A view container is REUSED when its tab navigates to another file, and arrives still
		   carrying the previous file's --settings-msg-* properties and classes. Applied at the
		   switch rather than left to the first message to render: that gate is an identity check
		   on the FILE's config, so returning to an unchanged file skips it, and a back/forward
		   that re-inserts a rendered view runs no processor at all. */
		await this.applyConfigToFile(newFile);

		// the container now matches this file's config, so the first message to render would
		// otherwise apply the identical thing again
		const note = this.getChatNote(newFile);
		note.lastAppliedConfig = note.configCache;

		addScrollButtons(view);
		// bound to this view, so the button filters the file it belongs to
		addPinButton(view, () => this.togglePinFilter(view));
		addSearchButton(view, () => this.toggleSearch(view));

		this.syncSearchBar(view);

		input.setCssStyles({ display: "flex" });
		// contentEl, not a mode-specific element: it survives a reading <-> live preview switch,
		// and the part that does depend on mode is picked in updateChatInputPosition
		if (input.parentElement !== view.contentEl) {
			view.contentEl.appendChild(input);
		}

		this.setupResizeObserver(view);

	}

	// the metadata event fires on every content change of every file, so the guard below is
	// what makes this the frontmatter handler (see DEVELOPMENT.md)
	async onYAMLChange(file: TFile){

		const cache = this.app.metadataCache.getFileCache(file);
		const newFrontmatter = cache?.frontmatter;
		const note = this.getChatNote(file);
		const oldFrontmatter = note.yamlCache;

		// by value, since every parse yields a fresh object. Missing on both sides stops here
		// too; a file that just lost its frontmatter must not, that's how a chat note ends
		if (JSON.stringify(newFrontmatter) === JSON.stringify(oldFrontmatter))  return;

		// read before updateFileConfig replaces the cache, and resolved rather than raw, so the
		// blank `author:` a new note is created with reads the same as no key at all
		const previousAuthor = note.configCache?.author;

		// caches the new config, and re-seeds yamlCache with the frontmatter above
		this.updateFileConfig(file);

		const ownerChanged = previousAuthor !== note.configCache?.author;

		// `?? false`: an unrendered file has no recorded status, and `false !== undefined`
		// would count "still not a chat note" as a change
		const previousStatus = note.isChatNote ?? false;
		const currentStatus = isChatFile(this.app, file);
		note.isChatNote = currentStatus;

		// a note that just became (or stopped being) a chat gains/loses the container class
		// and the view actions right away, not only once the rerender below lands
		this.syncChatViews();

		if (currentStatus && (currentStatus === previousStatus)) {
			// chat file YAML was changed -> apply styles AND the non-style settings
			await this.applyConfigToFile(file);

			// updateFileConfig replaced the config object, and the processor's guard is an
			// identity check - without this the next render applies the same config again
			note.lastAppliedConfig = note.configCache;

			/* The one override a sweep can't deliver: `is-owner` is a comparison against the
			   owner, stamped on the row at render, and CSS can't compare a row to a file-level
			   name. So the rows Live Preview has unmounted keep the old gutter - hence a full
			   rerender, affordable because the owner is normally set once per note. */
			if (ownerChanged) this.scheduleRefresh(file);

		} else if (currentStatus !== previousStatus) {
			// chat status has changed -> rerender completely
			this.scheduleRefresh(file);
		}

	}

	/* For anything that reaches back into the plugin - scheduleRefresh above all, whose rerender
	   ends in handleFileSwitch and would remount the chat input, keymap scopes and all, after
	   unload. Element-local timers don't need it; see DEVELOPMENT.md. */
	private later(fn: () => void, ms: number) {
		const id = window.setTimeout(() => {
			this.timeouts.delete(id);
			fn();
		}, ms);

		this.timeouts.add(id);
	}

	// delayed until the UI and the markdown have settled: run straight out of the metadata
	// handler it errors inside the embed-link plugin. The rerender repositions the input itself
	scheduleRefresh(file: TFile) {
		this.later(() => { void this.refreshFile(file); }, 300);
	}

	/* Every piece of this is bound to the element's OWN window, and re-run when the view moves to
	   another one - see "And more than one window" in DEVELOPMENT.md. */
	setupResizeObserver(view: MarkdownView) {
		const el = view.contentEl;
		if (!el) return;

		// the pending frame too: it would otherwise land on the view that just went away
		this.resizeObserver?.disconnect();
		this.cancelResizeFrame?.();
		this.cancelResizeFrame = null;
		this.windowMigration?.();
		this.windowMigration = null;

		const win = el.win as Window & { ResizeObserver: typeof ResizeObserver };

		// one measurement per frame, the way sticky.ts batches its scroll work: a drag delivers
		// several observation cycles across the elements below, and each pass reads two rects
		// and a computed style before writing back
		this.resizeObserver = new win.ResizeObserver(() => {
			if (this.cancelResizeFrame) return;

			const frame = win.requestAnimationFrame(() => {
				this.cancelResizeFrame = null;
				this.updateChatInputPosition(view);
			});

			this.cancelResizeFrame = () => { win.cancelAnimationFrame(frame); };
		});

		this.resizeObserver.observe(el);

		/* And the elements the geometry is actually read from: contentEl resizes first and
		   CodeMirror re-measures its own container a beat later, so watching contentEl alone
		   would measure the old box. The hidden subview's sizer
		   measures 0x0, which updateChatInputPosition already bails on. */
		for (const selector of Object.values(INPUT_SIZER_SELECTORS)) {
			const sizer = view.containerEl.querySelector(selector);
			if (sizer instanceof HTMLElement) this.resizeObserver.observe(sizer);
		}

		// a dragged-out tab MOVES the leaf rather than opening a file, so no file event re-runs
		// this - and everything above would stay bound to the window the view just left
		this.windowMigration = el.onWindowMigrated(() => {
			this.setupResizeObserver(view);
			this.updateChatInputPosition(view);
		});
	}

	repositionActiveChatInput() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view) this.updateChatInputPosition(view);
	}

	// sets the position and size of the message input field
	updateChatInputPosition(view: MarkdownView) {

		const input = this.getChatInput();

		/* Picked by mode, never by a `||` fallback: Obsidian keeps BOTH subviews mounted and
		   hides the inactive one, so the hidden element still exists and measures 0x0, which
		   would collapse the input. Each selector is scoped to its own
		   subview so a theme's stray sizer can't win. */
		const inner = view.containerEl.querySelector(
			view.getMode() === "preview"
				? INPUT_SIZER_SELECTORS.preview
				: INPUT_SIZER_SELECTORS.source
		);
		if (!(inner instanceof HTMLElement)) return;

		const rect = inner.getBoundingClientRect();
		// hidden pane, or called mid-transition before layout settled: keep the last good
		// geometry rather than writing a collapsed one that then sticks until a resize
		if (rect.width <= 0) return;

		/* Bubbles sit inset from the content area by the reply gutter, so the input takes the
		   same inset. Read off contentEl - that's where applyStyles sets it, so the value
		   doesn't depend on which subview `inner` happens to be. */
		const gutter = parseFloat(
			getComputedStyle(view.contentEl).getPropertyValue("--msg-reply-gutter")
		) || 0;

		// grows/shrinks the field around its own centre, so it stays on the bubbles' axis
		const widthOffset = this.settings.inputWidthOffset;

		const parentRect = view.contentEl.getBoundingClientRect();
		const offsetLeft = rect.left - parentRect.left;

		// a negative width is dropped by the browser, stranding the input at its old width
		input.style.width = `${Math.max(0, rect.width - gutter * 2 + widthOffset)}px`;
		input.style.left = `${offsetLeft + gutter - widthOffset / 2}px`;

		// the search bar shares the input's geometry, so it lines up with it and the bubbles
		this.searchBar?.container.setCssStyles({ width: input.style.width, left: input.style.left });

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
				/* Editor in live preview (or source mode). rebuildView is the only thing that
				   rebuilds the editor's widgets, and is NOT in obsidian.d.ts - so it is probed
				   rather than assumed, and falls back to the reading-mode path. */
				type RebuildableLeaf = WorkspaceLeaf & {
					rebuildView?: () => Promise<void>;
				};

				const rebuild = (leaf as RebuildableLeaf).rebuildView;
				if (typeof rebuild === "function") {
					await rebuild.call(leaf);
				} else {
					view.previewMode.rerender(true);
				}
			}

			this.updateChatInputPosition(view);
		}

		/* Mounting the input is onFileSwitch's job, and only the editor branch above provokes
		   the event that runs it (previewMode.rerender only redraws markdown). Run by hand
		   rather than relying on which branch fired what - it is idempotent. */
		this.handleFileSwitch();
	}

	/* Chat Note Creation */

	// hidden rather than removed: the ribbon only saves the order of registered icons, so a
	// removed one lost its place and came back at a stale position or at the top
	updateRibbonIcon() {
		this.ribbonIconEl?.toggleClass("chat-notes-ribbon-hidden", !this.settings.showRibbonIcon);
	}

	// `type` marks the note as a chat; `author` has no global setting to fall back on. The
	// overrides are left to the "Add override properties" command.
	buildChatNoteFrontmatter(): string {
		return [
			"---",
			"type: chat-note",
			"author: ",
			"---",
			""
		].join("\n");
	}

	/* Writes every override key the note doesn't already have, with an empty value - which
	   parses as null and so overrides nothing (see getFileOverrides). Their point is to exist:
	   Obsidian only suggests a property name once it appears somewhere in the vault. */
	async addOverrideProperties(file: TFile) {
		let added = 0;

		// typed here - the API hands the frontmatter over as `any`
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			for (const key of OVERRIDE_KEYS) {
				if (key in fm) continue;	// keeps whatever the user already set
				fm[key] = null;
				added++;
			}
		});

		new Notice(added === 0
			? "This note already has every override property"
			: `Added ${added} override ${added === 1 ? "property" : "properties"}`);
	}

	// the note only becomes a chat once metadataCache parses the new frontmatter, which
	// fires onYAMLChange and takes the "chat status changed" path from there
	async createChatNote(): Promise<TFile> {

		// resolves against the user's "Default location for new notes" preference
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
		const isOpening = !menu.classList.contains("menu-open");

		// the picker belongs to the open menu, so any toggle closes it
		this.closeMenu();

		if (isOpening) {
			menu.classList.add("menu-open");
			this.openMenu = menu;
		}
	}

	closeMenu() {
		this.closeEmojiPicker();

		this.openMenu?.classList.remove("menu-open");
		this.openMenu = null;
	}

	// a second press on the same button closes the picker instead of reopening it
	toggleEmojiPicker(file: TFile, msgId: string, anchor: HTMLElement) {
		const wasOpenHere = this.emojiPicker?.anchor === anchor;
		this.closeEmojiPicker();
		if (wasOpenHere) return;

		this.openEmojiPickerAt(anchor, (emoji) => { void this.handleReaction(file, msgId, "add", emoji); });
	}

	// the search bar's emoji button; the pick is typed into the search field
	toggleSearchEmojiPicker(anchor: HTMLElement) {
		const wasOpenHere = this.emojiPicker?.anchor === anchor;
		// an open message menu goes too, as any click outside it would close it
		this.closeMenu();
		if (wasOpenHere) return;

		this.openEmojiPickerAt(anchor, (emoji) => this.getSearchBar().insertAtCaret(emoji));
	}

	// only one picker is open at a time, whoever opened it
	private openEmojiPickerAt(anchor: HTMLElement, onPick: (emoji: string) => void) {
		const picker = openEmojiPicker(
			anchor,
			onPick,
			() => { if (this.emojiPicker === picker) this.emojiPicker = null; }
		);
		this.emojiPicker = picker;
	}

	closeEmojiPicker() {
		this.emojiPicker?.close();
		this.emojiPicker = null;
	}

	async handleReaction(file: TFile, msgId: string, change: ReactionChange, emoji: string) {
		const reactions = await this.changeReaction(file, msgId, change, emoji);
		if (reactions === null) return;

		// now rather than on the re-render the write triggers, so the click feels immediate
		for (const row of findMessageRows(this.app, file, msgId)) {
			updateReactionBar(row, reactions);
		}
	}

	/* The pinned state is flipped inside the write, against the file's own text, so two quick
	   clicks can't both read the same "before" value. `file` comes from the render that owns
	   the button, not from whichever file happens to be focused. */
	async handleMessagePin(file: TFile, msgId: string){

		const pinState = await this.toggleMessagePinned(file, msgId);
		if (pinState === null) return;

		// now rather than on the reparse the write triggers, so the click feels immediate.
		// Nothing else to paint: colour and filter both follow this attribute in CSS
		for (const row of findMessageRows(this.app, file, msgId)) {
			row.dataset.pinned = String(pinState);
		}
	}

	async handleReplyToggle(file: TFile, msgId: string) {

		const note = this.getChatNote(file);

		// clicking the same message again cancels the reply
		const wasSameTarget = note.replyTo === msgId;
		note.replyTo = wasSameTarget ? undefined : msgId;

		this.markReplyTarget(file);

		await this.updateReplyBanner();
	}

	// used by the banner's cross button and after a message is sent
	async handleCancelReply(file: TFile | null = this.currentFile) {

		if (!file) return;
		const note = this.getChatNote(file);
		if (!note.replyTo) return;

		note.replyTo = undefined;
		this.markReplyTarget(file);

		await this.updateReplyBanner();
	}

	// sets a row's data-reply-target flag (matched in styles.css) from the file's pending reply
	syncRowReplyTarget(file: TFile, row: HTMLElement, msgId: string) {
		const isTarget = this.getChatNote(file).replyTo === msgId;
		row.dataset.replyTarget = String(isTarget);

		if (isTarget) this.replyTargetRows.set(row, file);
		else this.replyTargetRows.delete(row);
	}

	/* Brings every row of the file in line with its pending reply: the rows flagged so far,
	   which may sit unmounted in Live Preview's cache where no query reaches them, and every row
	   mounted right now. A cached row that should GAIN the flag re-checks itself when it comes
	   back into view - see createElementsHTML. */
	private markReplyTarget(file: TFile) {
		for (const [row, rowFile] of this.replyTargetRows) {
			const id = row.dataset.msgId;
			if (rowFile === file && id !== undefined) this.syncRowReplyTarget(file, row, id);
		}

		for (const rowsById of collectMessageRows(this.app, file)) {
			for (const [id, rows] of rowsById) {
				for (const row of rows) this.syncRowReplyTarget(file, row, id);
			}
		}
	}

	// syncs the input's reply banner with the current file's pending reply target
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

		if (this.activeEditor?.container === newEditor.container) {
			return;
		}

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

	// `overrides` carries whatever was typed into the input's header row; empty falls
	// back to the configured default
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

		const author = overrides?.author || context.resolveDefaultAuthor();
		const timestamp = overrides?.timestamp || formatTimestamp();

		/* The id is allocated from the text being written, inside the atomic read-modify-
		   write, rather than from the cached model. Two sends inside the metadata debounce
		   would otherwise both read the same highest id and the second would collide. */
		await this.app.vault.process(file, data => {
			const [messages] = parseMessages(data);
			const scratch = new ArchiveContext(file, messages);

			const message = Message.create(
				new Header(scratch.nextMessageId(), author, timestamp, extra),
				content
			);

			// guarantee the block opens on its own line, whatever the file happened to end with
			const prefix = data.endsWith("\n") ? data : data + "\n";
			return prefix + message.toString();
		});
	}

	/* Jump to the end of the chat after a send. A single jump would land at the document's
	   *old* bottom - the write only schedules the codeblock processor. Waiting for the
	   render instead deadlocks: both view modes only render near the viewport, so a message
	   below the fold renders *because* something scrolled to it. Hence: scroll immediately,
	   then keep re-scrolling for a short window, dragging the render along. */
	scrollToBottomAfterSend(file: TFile) {

		const view = this.app.workspace.getLeavesOfType("markdown")
			.map(leaf => leaf.view)
			.find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === file.path);
		if (!view) return;

		this.holdScroll(view, () => scrollDocument(view, "bottom"));
	}

	/* Re-applies a scroll position every frame for a short window. The codeblock processor
	   renders asynchronously, so the height of a written block keeps changing for several
	   frames after the write, and a one-off scroll lands before that. A new hold replaces a
	   running one. */
	holdScroll(view: MarkdownView, apply: () => void) {
		this.cancelScrollHold?.();

		const start = performance.now();
		const win = view.containerEl.win;

		const tick = () => {
			this.cancelScrollHold = null;
			apply();

			if (performance.now() - start < SCROLL_HOLD_MS) {
				const frame = win.requestAnimationFrame(tick);
				this.cancelScrollHold = () => { win.cancelAnimationFrame(frame); };
			}
		};

		tick();
	}

	/* Replacing a block re-creates its widget empty, and the processor fills it a few frames
	   later. Until then everything below it moves up, which holdScroll can only correct a
	   frame after it painted - so the new block keeps the old height until it has rendered. */
	private reserveBlock(view: MarkdownView, file: TFile, msgId: string) {
		const row = findMessageRows(this.app, file, msgId)
			.find(row => isRowRendered(row) && view.contentEl.contains(row));
		if (!row?.parentElement) return;

		const key = blockKey(file, msgId);
		const reserved = { height: row.parentElement.offsetHeight, hovered: row.matches(":hover") };
		this.reservedBlocks.set(key, reserved);

		// a block the write removed never re-renders to clear it
		this.later(() => {
			if (this.reservedBlocks.get(key) === reserved) this.reservedBlocks.delete(key);
		}, SCROLL_HOLD_MS);
	}

	private getReservedBlock(file: TFile, source: string): { height: number; hovered: boolean } | undefined {
		if (this.reservedBlocks.size === 0) return undefined;
		try {
			return this.reservedBlocks.get(blockKey(file, extractMessageIdFromSource(source)));
		} catch {
			return undefined;
		}
	}

	/* Toggles the pinned-only filter for the view's file. State lives on the ChatNote, not on
	   the archive context: contexts are discarded whenever the file changes, so a filter kept
	   there would switch itself off mid-typing. */
	togglePinFilter(view: MarkdownView) {
		const file = view.file;
		if (!file) return;

		const note = this.getChatNote(file);
		note.pinFilter = !note.pinFilter;

		// the animation measures the rows first, so the editor only collapses after it
		this.applyPinFilter(file, { animate: true });
		this.filterExtension.refresh(file);
		this.remeasureReadingViews(file);
	}

	// the filters in effect for a file, or null when nothing is filtered
	getMessageFilter(file: TFile): MessageFilter | null {
		const note = this.getChatNote(file);
		const pinnedOnly = note.pinFilter === true;
		if (!pinnedOnly && !note.searchQuery) return null;
		return { pinnedOnly, query: note.searchQuery };
	}

	/* Applies the pinned-only filter by putting one class on each of the file's containers. The
	   hiding itself is CSS, matched against the data-pinned flag every row carries from render,
	   so it covers rows that mount later too. The walk below is only to animate what moved. */
	applyPinFilter(file: TFile, options?: { animate?: boolean }) {
		const on = this.getChatNote(file).pinFilter === true;
		const animate = options?.animate === true;

		const before = new Map<HTMLElement, number>();
		if (animate) {
			for (const rowsById of collectMessageRows(this.app, file)) {
				for (const rows of rowsById.values()) {
					for (const row of rows) before.set(row, row.getBoundingClientRect().top);
				}
			}
		}

		for (const container of getActiveContainers(this.app, file)) {
			container.classList.toggle("msg-pinned-only", on);
		}

		for (const [row, firstTop] of before) {
			// nothing to animate once the CSS rule above has hidden it
			if (!isRowRendered(row)) continue;

			const deltaY = firstTop - row.getBoundingClientRect().top;
			if (deltaY === 0) continue;

			// setCssStyles rather than .style.x =, per the Obsidian guidelines. These are
			// measured values, so they can't move to a class
			row.setCssStyles({ transform: `translateY(${deltaY}px)`, transition: "transform 0s" });
			void row.offsetHeight;	// forced reflow, so the transition below actually runs
			row.setCssStyles({ transition: "transform 180ms cubic-bezier(0.34, 1.35, 0.64, 1)", transform: "" });

			row.addEventListener("transitionend", () => {
				row.setCssStyles({ transition: "" });
			}, { once: true });
		}
	}

	/* Search */

	getSearchBar() {
		if (!this.searchBar) this.searchBar = createSearchBar(this);
		return this.searchBar;
	}

	/* Mounts the search bar on `view` if its file has the search open, and hides it otherwise.
	   Run on every file switch, like the chat input's mounting in onFileSwitch. */
	syncSearchBar(view: MarkdownView | null) {
		const bar = this.getSearchBar();
		const file = view?.file ?? null;

		// what was typed for the file being left still applies to that file, and an emoji
		// picked after the switch must not land in the next one
		if (this.searchFile !== file) {
			bar.flushPending();
			if (this.emojiPicker && bar.container.contains(this.emojiPicker.anchor)) this.closeEmojiPicker();
		}

		bar.container.parentElement?.classList.remove("chat-search-open");

		if (!view || !file || !this.getChatNote(file).searchOpen) {
			bar.container.setCssStyles({ display: "none" });
			this.searchFile = null;
			return;
		}

		/* Refilled only when the bar arrives from another file (or from closed). Focus moving
		   between two panes of the same note re-runs this too, and refilling then would replace
		   text still waiting on the debounce with the last applied query. */
		if (this.searchFile !== file) {
			bar.input.value = this.getChatNote(file).searchText ?? "";
		}

		this.searchFile = file;
		if (bar.container.parentElement !== view.contentEl) {
			view.contentEl.appendChild(bar.container);
		}
		// clears the first message from under the bar (see styles.css)
		view.contentEl.classList.add("chat-search-open");
		bar.container.setCssStyles({ display: "flex" });

		this.updateChatInputPosition(view);
		void this.updateSearchCount(file);
	}

	toggleSearch(view: MarkdownView) {
		const file = view.file;
		if (file && this.getChatNote(file).searchOpen && this.searchFile === file) {
			this.closeSearch();
		} else {
			this.openSearch(view);
		}
	}

	openSearch(view: MarkdownView) {
		const file = view.file;
		if (!file) return;

		this.getChatNote(file).searchOpen = true;
		this.syncSearchBar(view);

		const input = this.getSearchBar().input;
		input.focus();
		input.select();
	}

	// closing also clears the filter: a hidden filter with nothing on screen to explain it
	// would look like lost messages
	closeSearch() {
		const file = this.searchFile;
		if (!file) return;

		// or a debounce still pending would put the query straight back
		this.getSearchBar().cancelPending();

		this.setSearchQuery("");
		this.getChatNote(file).searchOpen = false;
		this.syncSearchBar(null);

		// back to the chat rather than leaving focus on a field that just disappeared
		if (this.currentFile === file) this.chatTextareaEl?.focus();
	}

	// what the search field's debounce calls, for the file the bar is mounted for
	setSearchQuery(raw: string) {
		const file = this.searchFile;
		if (!file) return;

		const note = this.getChatNote(file);
		note.searchText = raw;
		note.searchQuery = parseSearchQuery(raw) ?? undefined;

		this.applySearchFilter(file);
		this.syncSearchRows(file);
		this.filterExtension.refresh(file);
		// after the rows are synced: it measures them
		this.remeasureReadingViews(file);
		void this.updateSearchCount(file);
	}

	/* The switch for the search filter: one class on each of the file's containers, matched in
	   styles.css against the data-search-match flag on each row. Unlike the pinned flag, that
	   one changes with every query, so it is kept current by syncRowSearch below. */
	applySearchFilter(file: TFile) {
		const on = this.getChatNote(file).searchQuery !== undefined;
		for (const container of getActiveContainers(this.app, file)) {
			container.classList.toggle("msg-search-active", on);
		}
	}

	// sets a row's data-search-match flag from the file's current query
	syncRowSearch(file: TFile, row: HTMLElement, message: Message) {
		const query = this.getChatNote(file).searchQuery;
		const match = !query || messageMatches(message, query);
		row.dataset.searchMatch = String(match);
	}

	/* Brings every row of the file in line with a new query, synchronously - from the registry,
	   not a DOM query. Both view modes keep rendered rows DETACHED (Live Preview's widget cache,
	   Reading View's off-screen sections) where no query reaches them, and they come back
	   carrying whatever flag they had. Re-checking them only once back in view showed them for
	   a frame first, and Reading View measures them on insertion, before any check could run. */
	private syncSearchRows(file: TFile) {
		for (const [row, { file: rowFile, message }] of this.chatRows) {
			if (rowFile === file) this.syncRowSearch(file, row, message);
		}
	}

	/* Reading View measures every section once and lays the off-screen ones out by those stored
	   heights. A filter change leaves them stale: hidden messages kept their full height as
	   blank space, and later matches only appeared once scrolled to where they USED to be.
	   Resetting the measurements and queueing a render is what the renderer does itself after a
	   width change; it re-measures without re-running the codeblock processors. NOT public API,
	   so it is probed, and a renderer that doesn't have it is left as it was. */
	private remeasureReadingViews(file: TFile) {
		type PreviewRenderer = {
			sections?: { resetCompute?: () => void }[];
			queueRender?: () => void;
		};

		this.forEachMarkdownView(view => {
			if (view.file !== file || view.getMode() !== "preview") return;

			const renderer = (view.previewMode as unknown as { renderer?: PreviewRenderer }).renderer;
			if (!renderer?.sections || typeof renderer.queueRender !== "function") return;

			for (const section of renderer.sections) section.resetCompute?.();
			renderer.queueRender();
		});
	}

	// the authors and reactions of the searched file, for the search field's suggestions
	async getSearchSuggestionValues(): Promise<SuggestionValues> {
		const file = this.searchFile;
		if (!file) return { authors: [], reactions: [] };
		const context = await this.getArchiveContext(file);
		return collectSuggestionValues(Array.from(context.messageMap.values(), entry => entry.message));
	}

	// "3 of 120" in the bar, counted over the whole file rather than what is mounted
	private async updateSearchCount(file: TFile) {
		const bar = this.searchBar;
		if (!bar) return;

		const query = this.getChatNote(file).searchQuery;

		// before:/after: values that aren't dates are ignored; the warning names them
		const invalid = query?.invalid ?? [];
		bar.warning.setCssStyles({ display: invalid.length > 0 ? "flex" : "none" });
		if (invalid.length > 0) setTooltip(bar.warning, `Not a date, ignored: ${invalid.join(", ")}`);

		if (!query) {
			bar.count.setText("");
			return;
		}

		const context = await this.getArchiveContext(file);
		// the bar may have moved on, or the query changed, while the context was loading
		if (this.searchFile !== file || this.getChatNote(file).searchQuery !== query) return;

		let matches = 0;
		for (const { message } of context.messageMap.values()) {
			if (messageMatches(message, query)) matches += 1;
		}
		bar.count.setText(`${String(matches)} of ${String(context.messageMap.size)}`);
	}

	async scrollToMessage(file: TFile, msgId: string, options?: {
		behavior?: ScrollBehavior;
		block?: ScrollLogicalPosition;
		flash?: boolean;
		origin?: HTMLElement;
	}) {
		const context = await this.getArchiveContext(file);

		/* Only rows actually on the page (the inactive subview stays mounted, so `isConnected`
		   tells nothing) and - when the call came from a click - only the one sharing that
		   click's scroller. Strictly, not as a preference: a copy in another split pane is no
		   use to the reader looking at this one, and the fallback below mounts it where they
		   are actually looking. */
		const origin = options?.origin;
		const scroller = origin ? rowScroller(origin) : null;
		const rendered = findMessageRows(this.app, file, msgId).filter(isRowRendered);

		let row = scroller
			? rendered.find(r => rowScroller(r) === scroller)
			: rendered[0];

		/* Both view modes only render messages near the current scroll position, so a message
		   far from the viewport has no row at all. Jump to its source line first - that mounts
		   it through the codeblock processor - then wait for the row to appear. */
		if (!row) {
			const entry = context.messageMap.get(msgId);

			/* Reported here rather than at the callsite: this is the only place the reason is
			   known. The other failure below (no row after waiting) means the message exists but
			   couldn't be mounted, and must stay silent rather than claim it was deleted. */
			if (!entry) {
				new Notice("That message is no longer in the file");
				return false;
			}

			/* A message a filter hides never mounts - collapsed in Live Preview, display:none in
			   Reading View - so the jump below would move the reader to its line and then wait
			   out the timeout for nothing. Said instead, without moving them. */
			const filter = this.getMessageFilter(file);
			if (filter && isFilteredOut(entry.message, filter)) {
				// named after the filter that actually hides it, when both are on
				const byPin = filter.pinnedOnly && entry.message.header.extra.pinned !== "true";
				new Notice(byPin
					? "That message is hidden by the pinned messages filter"
					: "That message is hidden by the current search");
				return false;
			}

			const views = this.app.workspace.getLeavesOfType("markdown")
				.map(leaf => leaf.view)
				.filter((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === file.path);

			// the view the click happened in, so the jump doesn't move a different pane
			const view = (origin && views.find(v => v.containerEl.contains(origin))) || views[0];

			if (view) {
				view.setEphemeralState({ line: entry.startLine });
				row = await this.waitForMessageRow(file, msgId, scroller);
			}
		}

		if (!row) return false;

		row.scrollIntoView({
			behavior: options?.behavior ?? "smooth",
			block: options?.block ?? "center",
			inline: "nearest",
		});

		// wait until scrolling has finished and then play the flash animation
		await this.waitUntilVisible(row);

		if (options?.flash ?? true) {
			const target = row;
			// restarted, not just added: if the previous flash's class is still on the row,
			// adding it again would not replay the animation
			target.classList.remove("chat-message-scroll-flash");
			void target.offsetWidth;
			target.classList.add("chat-message-scroll-flash");
			this.later(() => target.classList.remove("chat-message-scroll-flash"), 900);
		}

		return true;
	}

	/* Polls until the codeblock processor has mounted a row for this message. Same selection
	   rule as scrollToMessage - a row in the hidden subview is already there and would end the
	   poll at once, with the one being waited for still unmounted. */
	async waitForMessageRow(
		file: TFile,
		msgId: string,
		scroller: Element | null = null,
		timeoutMs = 1500
	): Promise<HTMLElement | undefined> {
		const start = performance.now();
		// polled on the pane's own window: the main one's frames stall while a popout has focus
		const win = scroller?.win ?? activeWindow;

		for (;;) {
			const rendered = findMessageRows(this.app, file, msgId).filter(isRowRendered);
			const row = scroller
				? rendered.find(r => rowScroller(r) === scroller)
				: rendered[0];
			if (row) return row;

			if (performance.now() - start > timeoutMs) return undefined;
			await new Promise(resolve => win.requestAnimationFrame(resolve));
		}
	}

	// with no container, the element is measured against its own window's viewport - a row in a
	// popout has to be checked against that window, not the main one - and polled on it, for the
	// same reason as waitForMessageRow
	async waitUntilVisible(
		element: HTMLElement,
		container?: HTMLElement,
		margin = 20,
		timeoutMs = 1500
	): Promise<void> {
		return new Promise(resolve => {
			const start = performance.now();

			const check = () => {
				const rect = element.getBoundingClientRect();

				// overlap-based, not full containment, so it also resolves for messages
				// taller than the viewport
				let visible: boolean;

				if (!container) {
					visible =
						rect.top <= element.win.innerHeight - margin &&
						rect.bottom >= margin;
				} else {
					const cRect = container.getBoundingClientRect();
					visible =
						rect.top <= cRect.bottom - margin &&
						rect.bottom >= cRect.top + margin;
				}

				if (visible || performance.now() - start > timeoutMs) {
					resolve();
				} else {
					element.win.requestAnimationFrame(check);
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

	/* Colour pickers and sliders call this on every drag tick, so it does the least work that
	   still shows the change: the config path only, never a rerender - every setting in the tab
	   reaches the page through applyConfigToFile. Open files only; anything else gets a fresh
	   config from updateFileConfig when it is opened. */
	async saveSettings() {
		await this.saveData(this.settings);

		this.updateRibbonIcon();

		const openFiles = new Set<TFile>();
		this.forEachMarkdownView(view => {
			if (view.file && this.getIsChatNote(view.file)) openFiles.add(view.file);
		});
		// chats shown only in an embed (a canvas card, say) have no view of their own
		for (const path of getRenderedChatPaths(this.app)) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) openFiles.add(file);
		}

		for (const file of openFiles) {
			this.updateFileConfig(file);
			await this.applyConfigToFile(file);

			// updateFileConfig replaced the config object and the processor's guard is an
			// identity check, so this stops the next render applying the same config again
			const note = this.getChatNote(file);
			note.lastAppliedConfig = note.configCache;
		}

		// the max input height is only read while the textarea resizes itself
		this.chatTextareaEl?.dispatchEvent(new Event("input"));
	}

	updateFileConfig(file: TAbstractFile) {
		if (!(file instanceof TFile)) return;
		const overrides = getFileOverrides(this.app, file);
		const resolved = resolveConfig(this.settings, overrides);

		const note = this.getChatNote(file);
		note.configCache = resolved;

		// the frontmatter this config was resolved FROM, so onYAMLChange can tell whether a
		// metadata change touched the YAML at all. Seeded here so the two can never disagree
		note.yamlCache = this.app.metadataCache.getFileCache(file)?.frontmatter;

		return resolved;
	}

	/* Styling */

	applyStyles(container: HTMLElement, config: ChatConfig) {

		if (config.messageBgColor) {
			container.style.setProperty(
				"--settings-msg-bg-color",
				config.messageBgColor
			);
			// header/action icons sit on the bubble, so they follow the same contrast pick
			container.style.setProperty(
				"--settings-msg-text-color",
				getReadableTextColor(config.messageBgColor)
			);
		}

		/* A container property like the rest, reaching the pinned bubbles through the
		   [data-pinned="true"] rule in styles.css, which redefines the two above for that row.
		   Never painted per row: Live Preview re-inserts a cached row without re-running the
		   processor, so a swept inline value came back stale and then shadowed the cascade for
		   good - the same reason the pin filter and the reply outline are container rules. */
		if (config.messagePinColor) {
			container.style.setProperty(
				"--settings-msg-pin-color",
				config.messagePinColor
			);
			// made against the PINNED background - the pick above is for the normal bubble and
			// would be wrong whenever the two differ in brightness
			container.style.setProperty(
				"--settings-msg-pin-text-color",
				getReadableTextColor(config.messagePinColor)
			);
		}

		container.style.setProperty(
			"--settings-msg-corner-radius",
			`${config.messageCornerRadius}px`
		);

		// the input stays rounder than the bubbles, but tracks the same setting.
		// Named --chat-input-radius, since Obsidian's theme owns --input-radius globally.
		container.style.setProperty(
			"--chat-input-radius",
			`${(config.messageCornerRadius ?? 12) + 8}px`
		);

		if (config.enableButtonShadow) {
			container.classList.remove("menu-btn-no-shadow");
		} else {
			container.classList.add("menu-btn-no-shadow");
		}

		// toggled by class on the container, not by skipping the buttons when the header is
		// built - so these take effect on messages already on screen, without a rerender
		container.classList.toggle("msg-header-no-author", config.showMessageAuthor === false);
		container.classList.toggle("msg-header-no-timestamp", config.showMessageTimestamp === false);

		// widens the gutter via --msg-reply-gutter and reveals the badges every row carries
		container.classList.toggle("msg-show-author-badges", config.showAuthorBadges === true);

		// headings in messages take the bubble's contrast pick instead of the theme's colours
		container.classList.toggle("msg-contrast-headings", config.contrastHeadings === true);

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

	}

	/* Per-message state the container-level cascade can't express: which gutter the author badge
	   sits in, and the row's own pinned flag. Colour is deliberately not here - see applyStyles.

	   Walks the rendered rows rather than the message map: only rows on screen can be styled,
	   and in a long chat they are a tiny fraction of the file. */
	applyPerMessageStyles(file: TFile, context: ArchiveContext) {

		for (const rowsById of collectMessageRows(this.app, file)) {
			for (const [id, rows] of rowsById) {
				const message = context.messageMap.get(id)?.message;
				if (!message) continue;

				const pinned = message.header.extra.pinned === "true";

				for (const row of rows) {
					row.classList.toggle("is-owner", context.isOwnerMessage(message));

					// back in line with the model: a block rendered from a model that briefly
					// lagged the file (right after a write) carries the old flag, and both the
					// pinned colour and the pin filter match on exactly this
					row.dataset.pinned = String(pinned);
				}
			}
		}
	}

	/* Styles the embed a row was just inserted into, unless it already has the file's current
	   config. applyConfigToFile only reaches embeds with rows on screen, so one opened later
	   (a canvas, say) is styled from here. */
	private styleEmbedHost(file: TFile, row: HTMLElement) {
		const host = embedHostOf(row);
		if (!host) return;

		const config = this.getConfigCache(file);
		if (this.styledEmbeds.get(host) === config) return;

		this.applyStyles(host, config);
		this.styledEmbeds.set(host, config);
	}

	// the config that isn't CSS - plain values the message-building code reads
	applyConfigToContext(context: ArchiveContext, config: ChatConfig) {
		context.chatAuthor = config.author;
		context.defaultAuthorMode = config.defaultAuthorMode ?? "owner";
	}

	// pushes the file's config to its archive context (non-CSS settings) and to every container
	// it is open in (the CSS variables)
	async applyConfigToFile(file: TFile){

		const config = this.getConfigCache(file);
		// every caller records what it applied as lastAppliedConfig afterwards, so until then
		// this is the config the containers are still showing
		const previous = this.getChatNote(file).lastAppliedConfig;
		const context = await this.getArchiveContext(file);

		// before the container check on purpose: the context still needs the new config
		// even when the file isn't open in any view right now
		this.applyConfigToContext(context, config);

		for (const container of getActiveContainers(this.app, file)) {
			this.applyStyles(container, config);
		}
		for (const host of getEmbedHosts(this.app, file)) {
			this.applyStyles(host, config);
			this.styledEmbeds.set(host, config);
		}

		// once for the file, not once per container: it walks the rendered rows itself
		this.applyPerMessageStyles(file, context);

		// re-asserted after a render or a config change, without animating - nothing moved from
		// the reader's point of view
		this.applyPinFilter(file);
		this.applySearchFilter(file);

		// the author badge setting widens the gutter the input's geometry derives from;
		// the ResizeObserver won't fire for it, since contentEl itself doesn't resize
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view?.file?.path === file.path) {
			this.updateChatInputPosition(view);
		}

		// the badges and their insets follow the config, but only re-place themselves on scroll
		refreshSticky();

		/* The wider gutter re-wraps every bubble, so Reading View's stored heights for the
		   off-screen messages are wrong after it (see remeasureReadingViews). The one setting
		   that changes a message's height without a rerender - and only on an actual change,
		   since colour pickers and sliders come through here on every drag tick. */
		if (previous && previous.showAuthorBadges !== config.showAuthorBadges) {
			this.remeasureReadingViews(file);
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
			this.chatInputTeardown = result.teardown;
		}

		return this.chatInputEl;
	}

	/* The message textarea itself, never a query for it: the container also holds the author and
	   timestamp override fields, which come first in the DOM, so a "textarea, input" query
	   would resolve to the author field.

	   Both tolerate the input not existing yet - getChatInput builds it lazily. */
	getInputValue(): string {
		return this.chatTextareaEl?.value ?? "";
	}

	setInputValue(value: string) {
		if (!this.chatTextareaEl) return;

		this.chatTextareaEl.value = value;
		// resize the textarea to fit the restored content
		this.chatTextareaEl.dispatchEvent(new Event("input"));
	}

	getChatNote(file: TFile): ChatNote {
		let note = this.chatNotes.get(file);

		if (!note) {
			note = new ChatNote(file);
			this.chatNotes.set(file, note);
		}

		return note;
	}

	getConfigCache(file: TFile){
		let config = this.getChatNote(file).configCache;
		if (config === undefined){
			config = this.updateFileConfig(file);
			this.getChatNote(file).configCache = config;
			if (config === undefined) {
				throw new Error("Could not resolve the config: file is not a TFile");
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

	/* Replaces a file's parsed model when its text changes - the one invalidation rule the whole
	   cache needs. Gated on a context already existing: this event fires for every markdown file
	   in the vault on every save, and building models for files nobody has rendered would parse
	   the whole vault. Rebuilt rather than dropped because `data` is already in hand.

	   The metadata cache is debounced, so during typing the model briefly lags the file. Nothing
	   depends on it being current: writes re-locate their block by id, and a block the model
	   hasn't seen is rendered straight from its own source. */
	invalidateArchiveContext(file: TFile, data: string) {
		if (!this.archiveContexts.has(file.path)) return;

		if (!isChatFile(this.app, file)) {
			this.archiveContexts.delete(file.path);
			return;
		}

		const [messages] = parseMessages(data);
		const context = new ArchiveContext(file, messages);

		const config = this.getConfigCache(file);
		this.applyConfigToContext(context, config);
		this.archiveContexts.set(file.path, Promise.resolve(context));

		// rows already on screen were classed from the model that just got replaced; newly
		// mounted ones pick this up from the processor
		this.applyPerMessageStyles(file, context);
		this.applyPinFilter(file);
		this.applySearchFilter(file);

		// a sent, edited, pinned or deleted message can change what is hidden, and the count
		if (this.getMessageFilter(file)) this.filterExtension.refresh(file);
		if (this.getChatNote(file).searchQuery) void this.updateSearchCount(file);
	}

	async getArchiveContext(file: TFile): Promise<ArchiveContext> {

		// the promise is cached, not the context: the codeblock processor runs concurrently
		// for every message, and would otherwise build one context per message
		let contextPromise = this.archiveContexts.get(file.path);
		if (!contextPromise) {
			// lazy init -> scan the whole file and establish context
			contextPromise = this.createArchiveContext(file);
			this.archiveContexts.set(
				file.path,
				contextPromise
			);
		}

		return contextPromise;
	}

	/* The one path that rewrites a message block.

	   Locates the block by **id, in the text it is about to modify** - never from a cached line
	   number. Any edit above a message shifts its lines, and the model can lag the file by a
	   metadata debounce, so a write keyed off `entry.startLine` could splice into a different
	   message's header.

	   Reads through the open editor when there is one: unsaved changes haven't reached disk, so
	   vault.read would return superseded text and clobber what the user just typed. Writing back
	   through the editor also keeps undo history and the caret; vault.process is the fallback.

	   `transform` receives the block's own lines and returns their replacement, or null to remove
	   the block. Returns false when the message is no longer in the file. */
	async withMessageBlock(
		file: TFile,
		msgId: string,
		transform: (block: { message: Message; lines: string[] }) => string[] | null
	): Promise<boolean> {

		const view = this.app.workspace.getLeavesOfType("markdown")
			.map(leaf => leaf.view)
			.find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === file.path);

		const editor = view?.getMode() === "source" ? view.editor : undefined;

		/* Locates the block in `text`, applies the transform and refreshes the model from the
		   result, BEFORE it is written - not after, and not by waiting for the debounced metadata
		   cache. The write re-renders the block, and the codeblock processor is async: it captures
		   a context, yields, and resumes with it. Refreshing afterwards means it captured the
		   pre-write model and rebuilt the row describing the old state, which no sweep can fix -
		   the row doesn't exist yet.

		   If the write then fails, the model is briefly ahead of the file; the next metadata
		   change puts it back. */
		const rewrite = (text: string) => {
			const [messages] = parseMessages(text);
			const block = messages.get(msgId);
			if (!block) return null;

			const lines = text.split("\n");
			const blockLines = lines.slice(block.startLine, block.endLine + 1);
			const replacement = transform({ message: block.message, lines: blockLines });

			const updatedLines = [...lines];
			updatedLines.splice(
				block.startLine,
				block.endLine - block.startLine + 1,
				...(replacement ?? [])
			);
			const updated = updatedLines.join("\n");

			this.invalidateArchiveContext(file, updated);
			return { block, replacement, updated };
		};

		let found = false;

		if (editor) {
			// synchronous from read to write, so nothing can land in between
			const result = rewrite(editor.getValue());

			if (result) {
				found = true;
				const { block, replacement } = result;

				/* CodeMirror scrolls the selection into view on a document change, and replacing
				   the block re-creates its widget. Between them the view jumps - to wherever the
				   caret happens to sit, which after clicking a button is usually somewhere else
				   in the note entirely. Toggling a pin should not move the reader. */
				const cm = editor;
				const scroll = cm.getScrollInfo();
				if (view) this.reserveBlock(view, file, msgId);

				cm.replaceRange(
					replacement === null ? "" : replacement.join("\n") + "\n",
					{ line: block.startLine, ch: 0 },
					{ line: block.endLine + 1, ch: 0 }
				);

				// held rather than restored once - the re-created widget resizes as it renders
				if (view) this.holdScroll(view, () => cm.scrollTo(scroll.left, scroll.top));
			}
		} else {
			/* The whole read-modify-write runs inside process, on the text it hands over. A
			   vault.read before it would leave a gap: two quick writes (a reaction pill clicked
			   twice) both read the same text, and the second overwrote the first. */
			await this.app.vault.process(file, (data) => {
				const result = rewrite(data);
				found = result !== null;
				return result ? result.updated : data;
			});
		}

		if (!found) new Notice("That message is no longer in the file");
		return found;
	}

	/* Repairs a file whose ids were broken by hand (duplicates, gaps, pasted blocks). The
	   renumber itself is `renumberMessageIds` in util.ts - pure, and covered by tests; what is
	   left here is reading the text from the right place and writing it back. */
	async recalculateMessageIds(file: TFile) {

		if (!isChatFile(this.app, file)) return;

		const view = this.app.workspace.getLeavesOfType("markdown")
			.map(leaf => leaf.view)
			.find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === file.path);

		const editor = view?.getMode() === "source" ? view.editor : undefined;
		const text = editor ? editor.getValue() : await this.app.vault.read(file);

		const result = renumberMessageIds(text);
		if (!result) {
			new Notice("No messages to renumber");
			return;
		}

		const { lines, firstBlockLine, blockCount, newIds, droppedReplies } = result;
		const updated = lines.join("\n");

		// model first, then the write - see withMessageBlock
		this.invalidateArchiveContext(file, updated);
		this.remapReplyTarget(file, newIds);

		if (editor) {
			const cm = editor;
			const scroll = cm.getScrollInfo();

			/* From the first block to the end of the document, so the frontmatter above it is
			   never rewritten. Not to the last block's endLine: dropping a reply_to line
			   changes the line count, so those numbers no longer describe the patched text. */
			const span = lines.slice(firstBlockLine).join("\n");
			cm.replaceRange(
				span,
				{ line: firstBlockLine, ch: 0 },
				{ line: cm.lastLine(), ch: cm.getLine(cm.lastLine()).length }
			);

			if (view) this.holdScroll(view, () => cm.scrollTo(scroll.left, scroll.top));
		} else {
			await this.app.vault.process(file, () => updated);
		}

		new Notice(
			droppedReplies === 0
				? `Renumbered ${String(blockCount)} messages`
				: `Renumbered ${String(blockCount)} messages, dropped ${String(droppedReplies)} reply link(s) with no target`
		);
	}

	// the pending reply holds an id the renumber just replaced
	private remapReplyTarget(file: TFile, newIds: Map<string, string>) {
		const note = this.getChatNote(file);
		if (!note.replyTo) return;

		note.replyTo = newIds.get(note.replyTo);
		this.markReplyTarget(file);
		void this.updateReplyBanner();
	}

	/* Flips a message's pinned state and reports the new one (null if the write didn't
	   happen). The flip is decided from the file's own text inside the write, so two rapid
	   clicks can't both read the same "before" value and cancel each other out. */
	async toggleMessagePinned(file: TFile, msgId: string): Promise<boolean | null> {

		let pinned: boolean | null = null;

		/* Patched in place rather than round-tripped through Message.toString(), which would
		   reorder the header's keys and renormalise the body - a large diff for one flag. */
		const ok = await this.withMessageBlock(file, msgId, ({ message, lines }) => {
			if (!lines.includes("~~~")) return lines;

			pinned = message.header.extra.pinned !== "true";
			return setHeaderField(lines, "pinned", String(pinned));
		});

		return ok ? pinned : null;
	}

	/* Adds or removes one reaction and reports the resulting list (null if the write didn't
	   happen). Decided from the file's own text inside the write, like the pin. */
	async changeReaction(file: TFile, msgId: string, change: ReactionChange, emoji: string): Promise<Reaction[] | null> {

		let reactions: Reaction[] | null = null;

		const ok = await this.withMessageBlock(file, msgId, ({ message, lines }) => {
			if (!lines.includes("~~~")) return lines;

			const current = readReactions(message.header);
			const next = change === "add" ? addReaction(current, emoji) : removeReaction(current, emoji);
			reactions = next;

			return setHeaderField(lines, REACTIONS_KEY, next.length > 0 ? serializeReactions(next) : null);
		});

		return ok ? reactions : null;
	}
}

