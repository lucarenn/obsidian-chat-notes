import { Plugin, MarkdownRenderer, MarkdownRenderChild, TFile, MarkdownView, WorkspaceLeaf, TAbstractFile, Notice, normalizePath } from "obsidian";
import { Header, Message, ChatNote, ArchiveContext } from "./types"
import { DEFAULT_SETTINGS, ChatNotesPluginSettings, ChatNotesSettingTab, ChatConfig, getFileOverrides, resolveConfig, OVERRIDE_KEYS } from "./settings"
import { createElementsHTML, addScrollButtons, createChatInput, addPinButton, removeChatViewActions } from "./ui"
import { isChatFile, scrollDocument, extractMessageIdFromSource, parseMessages, renumberMessageIds, getActiveContainers, getReadableTextColor, formatTimestamp, findMessageRows, collectMessageRows, isRowRendered, rowScroller } from "./util"
import { ConfirmModal } from "./modals"

const NEW_CHAT_NOTE_NAME = "Untitled chat";

// what a chat-message block renders as when it can't be shown as a message: in a note that
// isn't a chat, or while the block is still being typed and doesn't parse yet
function renderFallbackBlock(el: HTMLElement, source: string) {
	const fallback = document.createElement("pre");
	const code = document.createElement("code");

	code.addClass("language-chat-message");
	code.textContent = source;

	fallback.appendChild(code);
	el.appendChild(fallback);
}

// how long "Scroll to bottom on send" keeps re-scrolling (see scrollToBottomAfterSend)
const SCROLL_ON_SEND_PIN_MS = 500;

// escapes a value for a double-quoted CSS attribute selector - vault paths are user text and
// may contain either of these
function cssAttr(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

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
	chatInputTeardown: (() => void) | null = null;

	private chatNotes = new WeakMap<TFile, ChatNote>();			// holds metadata and cache of the files
	private archiveContexts = new Map<string, Promise<ArchiveContext>>();	// holds messages/content of the files

	/* Pending reply targets, path -> message id. Mirrors each ChatNote's `replyTo`, which a
	   WeakMap can't be enumerated for - and the stylesheet below has to be rebuilt from all
	   of them at once. */
	private replyTargets = new Map<string, string>();
	private replyTargetStyleEl: HTMLStyleElement | null = null;

	/* Timers the plugin can take back - see `later` and the scroll loop below. Obsidian reclaims
	   neither, and a callback that lands after onunload runs against a plugin that is gone. */
	private timeouts = new Set<number>();
	private scrollPinFrame: number | null = null;

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

			if (!this.openMenu.contains(target)) {
				this.openMenu.classList.remove("menu-open");
				this.openMenu = null;
			}
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

				// the reply-target rule matches on data-chat-src, which the rows now carry
				// under the new path - so the rule has to be re-keyed, not just dropped
				const target = this.replyTargets.get(oldPath);
				this.replyTargets.delete(oldPath);
				if (target) this.replyTargets.set(file.path, target);
				this.refreshReplyTargetStyle();
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.archiveContexts.delete(file.path);

				this.replyTargets.delete(file.path);
				this.refreshReplyTargetStyle();
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

				const context = await this.getArchiveContext(file);
				const note = this.getChatNote(file);
				const config = this.getConfigCache(file);

				/* A message the parse hasn't seen yet - typed by hand, pasted, or appended a
				   moment ago - is read straight from `source` rather than forcing a reparse.
				   Live Preview re-runs this callback on every keystroke while a block is being
				   typed, so throwing on an unknown id fired once per character. */
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
					onReplyToggle: (targetId: string) => { void this.handleReplyToggle(file, targetId); },
					// callback for the reply banner; `origin` is the row it was clicked in
					onScrollToReply: (targetId: string, origin: HTMLElement) => { void this.scrollToMessage(file, targetId, { origin }); }
				});

				// nothing to do for the pinned-only filter here: the row carries data-pinned
				// and the container carries the filter class, so CSS covers it on mount
				el.appendChild(row);


				// only when the config actually changed - every later message inherits the
				// container properties the first one applied
				if (note.lastAppliedConfig !== note.configCache) {
					await this.applyConfigToFile(file);
					note.lastAppliedConfig = note.configCache;
				}

				/* Rendered under a child bound to THIS block, not under the plugin: anything
				   the markdown mounts (embeds, other plugins' processors) then unloads when
				   the block does. Passing the plugin kept every message ever rendered alive
				   until the plugin unloaded. */
				const renderChild = new MarkdownRenderChild(content);
				ctx.addChild(renderChild);

				await MarkdownRenderer.render(
					this.app,
					msg.content,
					content,
					ctx.sourcePath,
					renderChild
				);

			}
		);

		/* The file already open at load: whether its own file-open landed before the listener
		   above existed is a race, so run the switch by hand. Without it currentFile stays null,
		   and both save paths are gated on it - keystrokes on the first note of a session were
		   cached nowhere. */
		this.app.workspace.onLayoutReady(() => this.handleFileSwitch());
	}

	/* Obsidian reclaims none of this by itself: an element removed while focused fires no
	   blur (so the input's keymap scope would stay pushed and go on swallowing Mod+Enter),
	   and view actions and the container class live on views the plugin doesn't own. */
	onunload() {
		this.chatInputTeardown?.();
		this.resizeObserver?.disconnect();
		this.replyTargetStyleEl?.remove();
		this.chatInputEl?.remove();

		for (const id of this.timeouts) window.clearTimeout(id);
		this.timeouts.clear();
		if (this.scrollPinFrame !== null) cancelAnimationFrame(this.scrollPinFrame);

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

		// safe new config metadata changes to cache (this re-seeds yamlCache with the above)
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
			// chat status has changed -> rerender completly
			this.scheduleRefresh(file);
		}

	}

	/* window.setTimeout the plugin can take back. Timers in ui.ts are left as they are - those
	   only touch their own element, which is detached by the time they fire - but anything that
	   reaches back into the plugin has to be cancellable: scheduleRefresh's rerender ends in
	   handleFileSwitch, which would remount the chat input and its keymap scopes after unload. */
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

	repositionActiveChatInput() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view) this.updateChatInputPosition(view);
	}

	// sets the position and size of the message input field
	updateChatInputPosition(view: MarkdownView) {

		const input = this.getChatInput();

		/* Picked by mode, never by a `||` fallback: Obsidian keeps BOTH subviews mounted and
		   hides the inactive one, so the hidden element still exists and measures 0x0 - which
		   collapsed the input and threw it to the left. Each selector is scoped to its own
		   subview so a theme's stray sizer can't win. */
		const inner = view.getMode() === "preview"
			? view.containerEl.querySelector(".markdown-reading-view .markdown-preview-sizer")
			: view.containerEl.querySelector(".markdown-source-view .cm-contentContainer");
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

	// addRibbonIcon has no removal counterpart, so the element is detached by hand - and
	// only ever created once, since a second call would leave a duplicate icon behind
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
		if (this.openMenu && this.openMenu !== menu) {
			this.openMenu.classList.remove("menu-open");
		}

		const isOpening = !menu.classList.contains("menu-open");
		menu.classList.toggle("menu-open");
		this.openMenu = isOpening ? menu : null;

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

		this.setReplyTarget(file, note.replyTo);

		await this.updateReplyBanner();
	}

	// used by the banner's cross button and after a message is sent
	async handleCancelReply(file: TFile | null = this.currentFile) {

		if (!file) return;
		const note = this.getChatNote(file);
		if (!note.replyTo) return;

		note.replyTo = undefined;
		this.setReplyTarget(file, undefined);

		await this.updateReplyBanner();
	}

	/* Records which message a file's pending reply points at, and rewrites the stylesheet that
	   marks it. Nothing touches the rows: a generated rule styles whichever row matches,
	   whenever it mounts, so it survives Live Preview re-inserting a cached row. Clearing
	   matters just as much - a class removed by hand can't reach an unmounted row, which is
	   how the old target kept its outline while the new one got none. */
	private setReplyTarget(file: TFile, msgId: string | undefined) {
		if (msgId) this.replyTargets.set(file.path, msgId);
		else this.replyTargets.delete(file.path);

		this.refreshReplyTargetStyle();
	}

	private refreshReplyTargetStyle() {
		if (!this.replyTargetStyleEl) {
			/* Knowingly against obsidianmd/no-forbidden-elements, which exists to stop plugins
			   shipping their *appearance* from JS. No appearance ships here: the declarations
			   live in styles.css and this element carries only a selector naming the current
			   target, which changes at runtime and cannot be expressed statically. Removed
			   again in onunload. */
			// eslint-disable-next-line obsidianmd/no-forbidden-elements
			this.replyTargetStyleEl = document.createElement("style");
			document.head.appendChild(this.replyTargetStyleEl);
		}

		// the rule carries no appearance of its own - it raises the custom properties that
		// styles.css already consumes, so the look stays in one place
		const rules: string[] = [];
		for (const [path, msgId] of this.replyTargets) {
			rules.push(
				`.chat-message-row[data-chat-src="${cssAttr(path)}"][data-msg-id="${cssAttr(msgId)}"] {`,
				`	--msg-reply-outline: 2px solid var(--settings-msg-reply-color, #57467e);`,
				`	--msg-reply-btn-opacity: 1;`,
				`	--msg-reply-btn-events: auto;`,
				`}`
			);
		}

		this.replyTargetStyleEl.textContent = rules.join("\n");
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

		const start = performance.now();

		const pin = () => {
			this.scrollPinFrame = null;
			scrollDocument(view, "bottom");

			if (performance.now() - start < SCROLL_ON_SEND_PIN_MS) {
				this.scrollPinFrame = requestAnimationFrame(pin);
			}
		};

		pin();
	}

	/* Toggles the pinned-only filter for the view's file. State lives on the ChatNote, not on
	   the archive context: contexts are discarded whenever the file changes, so a filter kept
	   there would switch itself off mid-typing. */
	togglePinFilter(view: MarkdownView) {
		const file = view.file;
		if (!file) return;

		const note = this.getChatNote(file);
		note.pinFilter = !note.pinFilter;

		this.applyPinFilter(file, { animate: true });
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

		for (;;) {
			const rendered = findMessageRows(this.app, file, msgId).filter(isRowRendered);
			const row = scroller
				? rendered.find(r => rowScroller(r) === scroller)
				: rendered[0];
			if (row) return row;

			if (performance.now() - start > timeoutMs) return undefined;
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

				// overlap-based, not full containment, so it also resolves for messages
				// taller than the viewport
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

	// the config that isn't CSS - plain values the message-building code reads
	applyConfigToContext(context: ArchiveContext, config: ChatConfig) {
		context.chatAuthor = config.author;
		context.defaultAuthorMode = config.defaultAuthorMode ?? "owner";
	}

	// pushes the file's config to its archive context (non-CSS settings) and to every container
	// it is open in (the CSS variables)
	async applyConfigToFile(file: TFile){

		const config = this.getConfigCache(file);
		const context = await this.getArchiveContext(file);

		// before the container check on purpose: the context still needs the new config
		// even when the file isn't open in any view right now
		this.applyConfigToContext(context, config);

		for (const container of getActiveContainers(this.app, file)) {
			this.applyStyles(container, config);
		}

		// once for the file, not once per container: it walks the rendered rows itself
		this.applyPerMessageStyles(file, context);

		// re-asserted after a render or a config change, without animating - nothing moved from
		// the reader's point of view
		this.applyPinFilter(file);

		// the author badge setting widens the gutter the input's geometry derives from;
		// the ResizeObserver won't fire for it, since contentEl itself doesn't resize
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view?.file?.path === file.path) {
			this.updateChatInputPosition(view);
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
	   timestamp override fields, which come first in the DOM, so a "textarea, input" selector
	   list resolved to the author field and drafts were saved there instead.

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
	   message's header. That was silent corruption.

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
		const text = editor ? editor.getValue() : await this.app.vault.read(file);

		const [messages] = parseMessages(text);
		const block = messages.get(msgId);
		if (!block) {
			new Notice("That message is no longer in the file");
			return false;
		}

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

		/* Refresh the model from the text about to be written, BEFORE writing it - not after,
		   and not by waiting for the debounced metadata cache. The write re-renders the block,
		   and the codeblock processor is async: it captures a context, yields, and resumes with
		   it. Refreshing afterwards means it captured the pre-write model and rebuilt the row
		   describing the old state, which no sweep can fix - the row doesn't exist yet.

		   If the write then fails, the model is briefly ahead of the file; the next metadata
		   change puts it back. */
		this.invalidateArchiveContext(file, updated);

		if (editor) {
			/* CodeMirror scrolls the selection into view on a document change, and replacing
			   the block re-creates its widget. Between them the view jumps - to wherever the
			   caret happens to sit, which after clicking a button is usually somewhere else
			   in the note entirely. Toggling a pin should not move the reader. */
			const cm = editor;
			const scroll = cm.getScrollInfo();

			cm.replaceRange(
				replacement === null ? "" : replacement.join("\n") + "\n",
				{ line: block.startLine, ch: 0 },
				{ line: block.endLine + 1, ch: 0 }
			);

			cm.scrollTo(scroll.left, scroll.top);
			// again after layout settles - the re-created widget can resize as it renders,
			// and the scroll correction has to land after that, not before
			requestAnimationFrame(() => cm.scrollTo(scroll.left, scroll.top));
		} else {
			await this.app.vault.process(file, () => updated);
		}

		return true;
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

			cm.scrollTo(scroll.left, scroll.top);
			requestAnimationFrame(() => cm.scrollTo(scroll.left, scroll.top));
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
		this.setReplyTarget(file, note.replyTo);
		void this.updateReplyBanner();
	}

	/* Flips a message's pinned state and reports the new one (null if the write didn't
	   happen). The flip is decided from the file's own text inside the write, so two rapid
	   clicks can't both read the same "before" value and cancel each other out. */
	async toggleMessagePinned(file: TFile, msgId: string): Promise<boolean | null> {

		let pinned: boolean | null = null;

		const ok = await this.withMessageBlock(file, msgId, ({ lines }) => {
			/* Patched in place rather than round-tripped through Message.toString(), which
			   would reorder the header's keys and renormalise the body - a large, surprising
			   diff for one flag. On a malformed block the lines go back untouched, NOT null:
			   null means "delete this block". */
			const headerEnd = lines.indexOf("~~~");
			if (headerEnd === -1) return lines;

			// searched in the header only: a message body is free to contain a line that
			// happens to start with "pinned:", and it must not be mistaken for the flag
			const existing = lines
				.slice(0, headerEnd)
				.findIndex(line => line.startsWith("pinned:"));

			// the value the way Header.fromLines reads it, so "pinned:true" counts too
			const wasPinned = existing !== -1
				&& lines[existing]?.slice("pinned:".length).trim() === "true";

			pinned = !wasPinned;

			const updated = [...lines];
			if (existing !== -1) {
				updated[existing] = `pinned: ${pinned}`;
			} else {
				updated.splice(headerEnd, 0, `pinned: ${pinned}`);
			}

			return updated;
		});

		return ok ? pinned : null;
	}
}

