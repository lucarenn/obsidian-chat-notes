import { Plugin, MarkdownRenderer, TFile, MarkdownView, WorkspaceLeaf, TAbstractFile, Notice, normalizePath } from "obsidian";
import { Header, Message, ChatNote, ArchiveContext } from "./types"
import { DEFAULT_SETTINGS, ChatNotesPluginSettings, ChatNotesSettingTab, ChatConfig, getFileOverrides, resolveConfig } from "./settings"
import { createElementsHTML, addScrollButtons, createChatInput, addPinButton } from "./ui"
import { isChatFile, scrollDocument, extractMessageIdFromSource, parseMessages, getActiveContainers, getReadableTextColor, formatTimestamp, findMessageRows, collectMessageRows } from "./util"

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

	private chatNotes = new WeakMap<TFile, ChatNote>();			// holds metadata and cache of the files
	private archiveContexts = new Map<string, Promise<ArchiveContext>>();	// holds messages/content of the files

	/* Pending reply targets, path -> message id. Mirrors each ChatNote's `replyTo`, which a
	   WeakMap can't be enumerated for - and the stylesheet below has to be rebuilt from all
	   of them at once. */
	private replyTargets = new Map<string, string>();
	private replyTargetStyleEl: HTMLStyleElement | null = null;

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
		const [messages] = parseMessages(text);

		const context = new ArchiveContext(
			file,
			messages
		);

		// the message-derived fields come from the constructor; these come from the config
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

		   Two events, because neither covers the other. "active-leaf-change" fires when the
		   focused tab or pane changes - including to another leaf showing the SAME file, which
		   the single input element still has to move to. "file-open" fires when the file inside
		   a leaf changes: opening a note in the current tab keeps the leaf, so nothing else
		   announces it, and the input would go on showing the previous file's draft while
		   caching keystrokes against it. It also covers the file already open when the plugin
		   loads, which no leaf change announces.

		   Both firing for one switch (a tab change that is also a file change) is harmless -
		   every step of onFileSwitch is idempotent, and the second pass restores the draft it
		   just saved. */
		const handleFileSwitch = () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			const file = view?.file;
			if (!view || !file) return;

			this.updateFileConfig(file);
			void this.onFileSwitch(file, view).catch(err => {
				console.error("Failed to switch chat file", err);
			});
		};

		this.registerEvent(this.app.workspace.on("active-leaf-change", handleFileSwitch));
		this.registerEvent(this.app.workspace.on("file-open", handleFileSwitch));

		// workspace "resize" rather than window "resize": it also fires for sidebar and
		// split changes, which resize the pane without resizing the window
		this.registerEvent(
			this.app.workspace.on("resize", () => this.repositionActiveChatInput())
		);

		/* The only event that fires on a reading <-> live preview switch, or when a view is
		   rebuilt in place (e.g. by a refresh plugin). active-leaf-change doesn't fire - the
		   leaf never changes - and the ResizeObserver watches contentEl, which keeps its size
		   across the switch. Without this the input keeps whatever geometry it measured in
		   the previous mode. */
		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.repositionActiveChatInput())
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

				// Only render if the file has type: chat in yaml properties
				if (!this.getIsChatNote(file)) {
					renderFallbackBlock(el, source);
					return;
				}

				const context = await this.getArchiveContext(file);
				const note = this.getChatNote(file);
				const config = this.getConfigCache(file);

				/* The block's own text is right here, so a message the parse hasn't seen -
				   typed by hand, pasted, or appended a moment ago - is read straight from
				   `source` instead of forcing a reparse. Live Preview re-runs this callback
				   on every keystroke while a block is being typed, so throwing (or
				   rebuilding) on an unknown id fired once per character. */
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

				// Create HTML structure for message
				const {content, row} = createElementsHTML({
					plugin: this,
					ctx,
					msg,
					author_text: msg.header.author ?? config.author,
					context,
					// every callback closes over THIS file, so a click in a background leaf
					// acts on the message it belongs to rather than on whatever is focused
					onToggle: this.handleMenuToggle.bind(this),				// callback for toggling the action menu
					onHighlight: (targetId: string) => { void this.handleMessagePin(file, targetId); },
					onReplyToggle: (targetId: string) => { void this.handleReplyToggle(file, targetId); },
					onScrollToReply: (targetId: string) => { void this.scrollToMessage(file, targetId); }	// callback for the reply banner
				});

				// nothing to do for the pinned-only filter here: the row carries data-pinned
				// and the container carries the filter class, so CSS covers it on mount
				el.appendChild(row);


				// apply the config styles to all html containers of the file (cascades down to every individual message)
				// apply them only if a new config is present. Later rendered messages will still use the container variables set by earlier messages
				if (note.lastAppliedConfig !== note.configCache) {
					await this.applyConfigToFile(file);
					note.lastAppliedConfig = note.configCache;
				}

				// highlight message if its pinned - `row` and `config` are the ones for THIS
				// file, not for whichever file happens to be focused
				if (msg.header.extra.pinned === "true") {
					this.applyMessageHighlightStyle(row, config, true)
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

		/* create the input for the file already open at load. Whether that file's own file-open
		   landed before the listener above existed is a race, so this runs the switch by hand:
		   without it currentFile stays null, and both save paths are gated on it - keystrokes
		   on the first note of a session were cached nowhere. Positioning follows from the
		   ResizeObserver onFileSwitch installs, as it does for every other switch. */
		this.app.workspace.onLayoutReady(handleFileSwitch);
	}

	onunload() {
		this.resizeObserver?.disconnect();
		this.replyTargetStyleEl?.remove();
		this.chatInputEl?.remove();
	}

	/* Event Helper Methods */

	async onFileSwitch(newFile: TFile, view: MarkdownView) {

		console.log("FILE SWITCH ")
		const input = this.getChatInput();

		// Save old file input
		if (this.currentFile) {
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

		/* A view container is REUSED when its tab navigates to another file, and it goes on
		   carrying the previous file's --settings-msg-* properties and classes. Applied here,
		   at the switch, rather than left to the first message that renders: that gate is an
		   identity check on the FILE's config, so coming back to a file whose config hasn't
		   changed since it was last applied skips it - and a back/forward that re-inserts an
		   already rendered view runs no processor at all. Either way the container kept the
		   other file's colours.

		   Also covers the pinned-only filter, which applyConfigToFile re-asserts. */
		await this.applyConfigToFile(newFile);

		// the container now matches this file's config, so the first message to render would
		// otherwise apply the identical thing again
		const note = this.getChatNote(newFile);
		note.lastAppliedConfig = note.configCache;

		// add scroll buttons to the newly opened chat file
		addScrollButtons(view);
		// bound to this view, so the button filters the file it belongs to
		addPinButton(view, () => this.togglePinFilter(view));

		// eslint-disable-next-line obsidianmd/no-static-styles-assignment
		input.style.display = "flex";
		// contentEl, not a mode-specific element: it survives a reading <-> live preview switch,
		// and the part that does depend on mode is picked in updateChatInputPosition
		if (input.parentElement !== view.contentEl) {
			view.contentEl.appendChild(input);
		}

		// Watch for iternal widow resizes (and update chat input field position)
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

		console.log("metadata change")

		// safe new config metadata changes to cache (this re-seeds yamlCache with the above)
		this.updateFileConfig(file);

		// `?? false`: an unrendered file has no recorded status, and `false !== undefined`
		// would count "still not a chat note" as a change
		const previousStatus = note.isChatNote ?? false;
		const currentStatus = isChatFile(this.app, file);
		note.isChatNote = currentStatus;

		if (currentStatus && (currentStatus === previousStatus)) {
			// chat file YAML was changed -> apply styles AND the non-style settings
			await this.applyConfigToFile(file);

			// updateFileConfig replaced the config object, and the processor's guard is an
			// identity check - without this the next render applies the same config again
			note.lastAppliedConfig = note.configCache;

		} else if (currentStatus !== previousStatus) {
			// chat status has changed -> rerender completly

			setTimeout(() => {
				// delay until UI + markdown settle
				void this.refreshFile(file);

				// the rerender triggers onFileSwitch, which repositions the input already

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

	repositionActiveChatInput() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view) this.updateChatInputPosition(view);
	}

	updateChatInputPosition(view: MarkdownView) {
		// set/update the position and size of the message input field

		const input = this.getChatInput();

		/* Picked by mode, never by a `||` fallback: Obsidian keeps BOTH subviews mounted and
		   hides the inactive one, so .cm-contentContainer still exists in reading mode - the
		   fallback never fired and the hidden element measured 0x0, collapsing the input and
		   throwing it to the left. Each selector is scoped to its own subview so a theme's
		   stray sizer can't win. */
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

	/* Frontmatter for a new chat note. Only `type` (what marks a chat at all) and `author`
	   (no global setting to fall back on) are written live - the rest stay commented out,
	   since a present key overrides the global setting permanently and would freeze the
	   note's appearance at creation time. */
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
			`# msgButtonShadow: ${s.enableButtonShadow}`,
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

		// paint every rendered copy now rather than waiting for the reparse the write
		// triggers - the click should feel immediate
		const config = this.getConfigCache(file);
		for (const row of findMessageRows(this.app, file, msgId)) {
			this.applyMessageHighlightStyle(row, config, pinState);
			// keeps the row's own flag in step, so the pinned-only filter reacts at once
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
	   whenever it happens to be mounted, so it survives Live Preview re-inserting a cached row
	   without re-running the codeblock processor. Clearing is just as important - a class
	   removed by hand can't reach a row that is unmounted at the time, which is how the old
	   target kept its outline while the new one got none. */
	private setReplyTarget(file: TFile, msgId: string | undefined) {
		if (msgId) this.replyTargets.set(file.path, msgId);
		else this.replyTargets.delete(file.path);

		this.refreshReplyTargetStyle();
	}

	private refreshReplyTargetStyle() {
		if (!this.replyTargetStyleEl) {
			/* Knowingly against obsidianmd/no-forbidden-elements, which exists to stop plugins
			   shipping their *appearance* from JS. Nothing of the sort happens here: every
			   declaration lives in styles.css, and this element carries only a selector naming
			   which row is currently the target - a fact that changes at runtime and cannot be
			   expressed statically (CSS cannot compare a container's attribute to a row's).
			   The alternative, re-asserting a class from a MutationObserver, costs a
			   document-wide query on every frame the DOM churns to achieve the same thing.
			   Removed again in onunload. */
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
			scrollDocument(view, "bottom");
			if (performance.now() - start < SCROLL_ON_SEND_PIN_MS) {
				requestAnimationFrame(pin);
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

	/* Applies the pinned-only filter by putting one class on each of the file's containers.
	   The hiding itself is CSS, matched against the data-pinned flag every row carries from
	   render - so it covers rows that mount later, or that Live Preview re-inserts from its
	   cache without re-running the codeblock processor. Nothing here walks the rows to hide
	   them; the walk below is only to animate what moved. */
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
			// offsetParent is null once the CSS rule above has hidden it
			if (!row.isConnected || row.offsetParent === null) continue;

			const deltaY = firstTop - row.getBoundingClientRect().top;
			if (deltaY === 0) continue;

			row.style.transform = `translateY(${deltaY}px)`;
			row.style.transition = "transform 0s";
			row.offsetHeight;	// forced reflow, so the transition below actually runs
			row.style.transition = "transform 180ms cubic-bezier(0.34, 1.35, 0.64, 1)";
			row.style.transform = "";

			row.addEventListener("transitionend", () => {
				row.style.transition = "";
			}, { once: true });
		}
	}

	async scrollToMessage(file: TFile, msgId: string, options?: {
		behavior?: ScrollBehavior;
		block?: ScrollLogicalPosition;
		highlight?: boolean;
	}) {
		const context = await this.getArchiveContext(file);

		let row = findMessageRows(this.app, file, msgId).find(r => r.isConnected);

		/* Both view modes only render messages near the current scroll position, so a message
		   far from the viewport has no row at all. Jump to its source line first - that mounts
		   it through the codeblock processor - then wait for the row to appear. */
		if (!row) {
			const entry = context.messageMap.get(msgId);

			/* Reported here rather than at the callsite, because this is the only place the
			   reason is known: the other failure below (no row after waiting) means the message
			   exists but couldn't be mounted, and must stay silent instead of claiming it was
			   deleted. Reaches the reply banners of rows that predate the delete - once such a
			   row re-renders it becomes the inert "Message not found" variant and can't be
			   clicked at all. */
			if (!entry) {
				new Notice("That message is no longer in the file");
				return false;
			}

			const view = this.app.workspace.getLeavesOfType("markdown")
				.map(leaf => leaf.view)
				.find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === file.path);

			if (view) {
				view.setEphemeralState({ line: entry.startLine });
				row = await this.waitForMessageRow(file, msgId);
			}
		}

		if (!row) return false;

		row.scrollIntoView({
			behavior: options?.behavior ?? "smooth",
			block: options?.block ?? "center",
			inline: "nearest",
		});

		// wait until scrolling has finished and then play the highlight animation
		await this.waitUntilVisible(row);

		if (options?.highlight ?? true) {
			const target = row;
			target.classList.add("chat-message-scroll-highlight");
			setTimeout(() => target.classList.remove("chat-message-scroll-highlight"), 900);
		}

		return true;
	}

	// polls until the codeblock processor has mounted a row for this message
	async waitForMessageRow(file: TFile, msgId: string, timeoutMs = 1500): Promise<HTMLElement | undefined> {
		const start = performance.now();

		for (;;) {
			const row = findMessageRows(this.app, file, msgId).find(r => r.isConnected);
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

		const note = this.getChatNote(file);
		note.configCache = resolved;

		// the frontmatter this config was resolved FROM, so onYAMLChange can tell whether a
		// metadata change touched the YAML at all. Seeded here so the two can never disagree
		note.yamlCache = this.app.metadataCache.getFileCache(file)?.frontmatter;

		return resolved;
	}

	/* Styling */

	async applyStyles(container: HTMLElement, config: ChatConfig, context: ArchiveContext) {

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

	/* Per-message styling that the container-level cascade can't express: which gutter the
	   author badge sits in, and the pinned bubbles that override the shared colour.

	   Walks the rendered rows rather than the message map - only rows on screen can be
	   styled, and in a long chat they are a tiny fraction of the file. */
	applyPerMessageStyles(file: TFile, context: ArchiveContext, config: ChatConfig) {

		for (const rowsById of collectMessageRows(this.app, file)) {
			for (const [id, rows] of rowsById) {
				const message = context.messageMap.get(id)?.message;
				if (!message) continue;

				const pinned = message.header.extra.pinned === "true";
				const color = pinned
					? config.messageHighlightColor
					: config.messageBgColor;

				for (const row of rows) {
					row.classList.toggle("is-owner", context.isOwnerMessage(message));

					/* Brings the row's own pinned flag back in line with the model. The
					   processor stamps it at render, but a block re-rendered from a model that
					   was momentarily behind the file (right after a write) carries the old
					   value - and the pinned-only filter matches on exactly this. */
					row.dataset.pinned = String(pinned);

					// `continue`, not `return` - one colourless message must not abandon the sweep
					if (!color) continue;

					row.style.setProperty("--settings-msg-bg-color", color);
					row.style.setProperty(
						"--settings-msg-text-color",
						getReadableTextColor(color)
					);
				}
			}
		}
	}

	// the config that isn't CSS - plain values the message-building code reads
	applyConfigToContext(context: ArchiveContext, config: ChatConfig) {
		context.chatAuthor = config.author;
		context.defaultAuthorMode = config.defaultAuthorMode ?? "owner";
	}

	/* Overrides the bubble colour for a highlighted (pinned) message. Takes the ROW, not the
	   bubble: the speech-bubble tail is a sibling of the bubble (it has to be - see
	   .chat-message's overflow:hidden) so a property set on the bubble would never reach it. */
	applyMessageHighlightStyle(target: HTMLElement, config: ChatConfig, isPinned: boolean){

		const color = isPinned
			? config.messageHighlightColor
			: config.messageBgColor;

		if (!color) return;

		target.style.setProperty(
			"--settings-msg-bg-color",
			color
		);
		// re-made against *this* background - the container-level pick is for the normal
		// bubble color and would be wrong whenever the two differ in brightness
		target.style.setProperty(
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

		for (const container of getActiveContainers(this.app, file)) {
			await this.applyStyles(container, config, context);
		}

		/* Once for the file, not once per container: it walks the rendered rows itself, so
		   running it inside the loop above just repeated the same sweep. */
		this.applyPerMessageStyles(file, context, config);

		// the pinned-only filter is a class on rows, so a re-render or a config sweep has to
		// re-assert it - without animating, since nothing moved from the reader's point of view
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
		}

		return this.chatInputEl;
	}

	/* The message textarea itself, never a query for it: the container also holds the author
	   and timestamp override fields, and those come first in the DOM. A selector list matches
	   in document order regardless of how it is written, so "textarea, input" resolved to the
	   author field - drafts were saved and restored there, and the real draft was never
	   touched (it looked like one draft shared by every file).

	   Both tolerate the input not existing yet: getChatInput builds it lazily, and
	   onFileSwitch is only the first caller by convention, not by construction. */
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
		// returns the existing ChatNote or creates a new empty one

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

	/* Replaces a file's parsed model when its text changes - the one invalidation rule the
	   whole cache needs, now that nothing fragile is cached alongside it.

	   Gated on a context already existing: this event fires for every markdown file in the
	   vault on every save, and building models for files nobody has rendered would parse the
	   whole vault. Rebuilt eagerly rather than dropped because `data` is already in hand; a
	   lazy drop would trade this parse for a parse *and* a read on the next render.

	   Note the metadata cache is debounced, so during typing the model briefly lags the file.
	   Nothing depends on it being current: writes re-locate their block by id, and a block
	   the model hasn't seen is rendered straight from its own source. */
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

		/* Rows already on screen were styled and classed from the model that just got
		   replaced. Newly mounted rows pick this up from the processor; these are the ones
		   that were already there. */
		this.applyPerMessageStyles(file, context, config);
		this.applyPinFilter(file);
	}

	async getArchiveContext(file: TFile): Promise<ArchiveContext> {

 		// the promise is cached, not the context: the codeblock processor runs concurrently
		// for every message, and would otherwise build one context per message
		let contextPromise = this.archiveContexts.get(file.path);
		if (!contextPromise) {
			// lazy init -> scan the whole file and establish context
			console.log("generating context:", file.path);
			contextPromise = this.createArchiveContext(file);
			this.archiveContexts.set(
				file.path,
				contextPromise
			);
		}

		return contextPromise;
	}

	/* The one path that rewrites a message block.

	   It locates the block by **id, in the text it is about to modify** - never from a cached
	   line number. Any edit above a message shifts its lines, and the context can lag the
	   file by a metadata debounce, so a write keyed off `entry.startLine` could seek the
	   header separator of a different message and splice into it. That was silent corruption.

	   Reads through the open editor when the file has one: an editor with unsaved changes has
	   not reached disk, so vault.read would return superseded text and the write would
	   clobber whatever the user had just typed. Writing back through the editor also keeps
	   undo history and the caret intact; vault.process is the atomic fallback otherwise.

	   `transform` receives the block's own lines and returns their replacement, or null to
	   remove the block entirely. Returns false when the message is no longer in the file. */
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

		/* Refresh the model from the text about to be written, BEFORE writing it, rather than
		   waiting for the metadata cache (debounced by roughly the editor's save delay).

		   Before the write, not after, because the write re-renders the block and the
		   codeblock processor is async: it calls getArchiveContext, yields on that promise,
		   and resumes with whatever context it captured. Refreshing afterwards means it
		   captured the pre-write one, so the row is rebuilt describing the old state - old
		   bubble colour, and a data-pinned the pinned-only filter then believes - and a sweep
		   running in between cannot help, because the row it needs to fix does not exist yet.
		   Refreshing first means every render the write provokes reads the new model.

		   If the write below then fails, the model is briefly ahead of the file; the next
		   metadata change puts it back. */
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

	/* Flips a message's pinned state and reports the new one (null if the write didn't
	   happen). The flip is decided from the file's own text inside the write, so two rapid
	   clicks can't both read the same "before" value and cancel each other out. */
	async toggleMessagePinned(file: TFile, msgId: string): Promise<boolean | null> {

		let pinned: boolean | null = null;

		const ok = await this.withMessageBlock(file, msgId, ({ lines }) => {
			// patched in place rather than round-tripped through Message.toString(), which
			// would reorder the header's keys and renormalise the body - a large, surprising
			// diff for what is one flag
			// hand the lines back untouched, NOT null - null means "delete this block"
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

