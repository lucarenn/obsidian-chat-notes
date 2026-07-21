import { Plugin, MarkdownRenderer, TFile, MarkdownView, WorkspaceLeaf, TAbstractFile } from "obsidian";
import { Message, ChatNote, ArchiveContext, MessageEntry } from "./types"
import { DEFAULT_SETTINGS, ChatNotesPluginSettings, ChatNotesSettingTab, ChatConfig, getFileOverrides, resolveConfig } from "./settings"
import { createElementsHTML, addScrollButtons, createChatInput } from "./ui"
import { isChatFile, scrollDocument, extractMessageIdFromSource, parseMessages, getActiveContainers } from "./util"

export default class ChatNotesPlugin extends Plugin {
	
	openMenu: HTMLElement | null = null;
	settings: ChatNotesPluginSettings;
	chatInputEl: HTMLElement;
	chatTextareaEl: HTMLTextAreaElement;
	resizeObserver: ResizeObserver | null = null;
	currentFile: TFile | null = null;

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
		const messages = parseMessages(source);
	
		return new ArchiveContext(
			file,
			messages
		);
	}

	async onload() {
		
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Chat');

		// load global settings
		await this.loadSettings();
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
			/* Detect yaml changes and refresh/rerender the file if the settings are overridden or it becomes or is no longer a chat note */

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
				const {wrapper, content} = createElementsHTML({
					plugin: this,
					ctx,
					msg,
					author_text: msg.header.author ?? config.author,
					onToggle: this.handleMenuToggle.bind(this),				// callback for toggling the action menu
					onHighlight: this.handleMessageHighlight.bind(this)		// callback for the highlight/pin button
				});
				
				// attach message to file html container
				el.appendChild(wrapper);
				entry.element = wrapper;
				
				// apply the config styles to all html containers of the file (cascades down to every individual message)
				// apply them only if a new config is present. Later rendered messages will still use the container variables set by earlier messages
				if (note.lastAppliedConfig !== note.configCache) {
					this.applyConfigStylesToFile(file);
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
			return;
		}

		// restore new file input if present
		this.currentFile = newFile
		const saved = this.getChatNote(newFile).inputCache ?? "";
		this.setInputValue(saved);

		// add scroll buttons to the newly opened chat file
		addScrollButtons(view);

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
			// chat file YAML was changed -> apply styles
			// TODO: detect and update other new settings (not just styles)

			const context = await this.getArchiveContext(file);
			if (context.pinnedMessagesAmount === 0) {
				console.log("Container based Styling")
				this.applyConfigStylesToFile(file);
			} else {
				
				console.log("Message based Styling")
				context.refreshStylesPerMessage(this.getConfigCache(file));
			}

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
		const rect = inner.getBoundingClientRect();
		const parentRect = view.contentEl.getBoundingClientRect();
		const offsetLeft = rect.left - parentRect.left;

		input.style.width = `${rect.width - margin * 2}px`;
		input.style.left = `${offsetLeft + margin}px`;

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

	/* Message Actions */

	handleMenuToggle(menu: HTMLElement) {
		if (this.openMenu && this.openMenu !== menu) {
			this.openMenu.classList.remove("menu-open");
		}

		const isOpening = !menu.classList.contains("menu-open");
		menu.classList.toggle("menu-open");
		this.openMenu = isOpening ? menu : null;

	}

	async handleMessageHighlight(msgId: string, isPinned: boolean){

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

	async appendMessage(file: TFile, content: string) {
		// TODO: create and save standart header for every chat? map?
		// const chat_header = new Header();
		// const msg = new Message(chat_header, content);
		await this.app.vault.append(file, "msg.toString()");

		// get view? Scroll down when sending new message?
		// -> either get all views of open files and scroll down in all of them of this given file, or just dont scroll at all and user can use the buttons
		scrollDocument(null, "bottom")
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

	applyStyles(container: HTMLElement, config: ChatConfig) {

		// console.log(container)
		if (!config.messageBgColor) return; // replace with set to default value?
		container.style.setProperty(
		  "--settings-msg-bg-color",
		  config.messageBgColor
		);
	  
		container.style.setProperty(
		  "--settings-msg-corner-radius",
		  `${config.messageCornerRadius}px`
		);

		if (config.enableButtonShadow) {
			container.classList.remove("menu-btn-no-shadow");
		} else {
			container.classList.add("menu-btn-no-shadow");
		}
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
	}

	applyConfigStylesToFile(file: TFile){
		// get all html containers of the open file and call applyScopedStyles on them with their current config

		console.log("applying styles to containers")
		const allContainers = getActiveContainers(this.app, file)
		if (!allContainers) return;
		const config = this.getConfigCache(file)!;
		for (const fileContainers of allContainers) {
			for (const container of fileContainers) {
				  this.applyStyles(container, config);
			}
		}

	}

	/* Helper Methods */

	getChatInput(): HTMLElement {
		if (!this.chatInputEl) {
			const result = createChatInput(this);
			this.chatInputEl = result.container;
			this.chatTextareaEl = result.textarea;
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

