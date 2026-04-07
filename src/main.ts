import { Plugin, MarkdownRenderer, setIcon, TFile, MarkdownView, WorkspaceLeaf, Notice } from "obsidian";
import { Message, Header, } from "./types"
import { DEFAULT_SETTINGS, ChatNotesPluginSettings, ChatNotesSettingTab } from "./settings"
import { createElementsHTML } from "./ui"
import { isChatFile, scrollToBottom } from "./util"


export default class ChatNotesPlugin extends Plugin {
	
	openMenu: HTMLElement | null = null;
	settings: ChatNotesPluginSettings;
	chatInputEl: HTMLElement;
	chatTextareaEl: HTMLTextAreaElement;
	resizeObserver: ResizeObserver | null = null;
	private chatFileState = new Map<string, boolean>();	// store for each file if its a chat file or not
	private inputState = new Map<string, string>();  // store for each file an individual message draft
	currentFile: TFile | null = null;

	activeEditor: {
		container: HTMLElement;
		restore: () => void;
	} | null = null;


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

	async onFileSwitch(leaf: WorkspaceLeaf) {

		if (!leaf) return;
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) return;
		const input = this.getChatInput();
		const newFile = view.file;

		// Save old file input
		if (this.currentFile && this.chatInputEl) {
			this.inputState.set(
				this.currentFile.path,
				this.getInputValue()
			);
		}

		// return if new file is not a chat file
		if (!newFile || !isChatFile(this.app, newFile)) {
			// eslint-disable-next-line obsidianmd/no-static-styles-assignment
			input.style.display = "none";
			this.resizeObserver?.disconnect();
			this.currentFile = null;
			return;
		}

		// restore new file input if present
		this.currentFile = newFile
		const saved = this.inputState.get(newFile.path) ?? "";
		this.setInputValue(saved);

		// eslint-disable-next-line obsidianmd/no-static-styles-assignment
		input.style.display = "flex";
		if (input.parentElement !== view.contentEl) {
			view.contentEl.appendChild(input);
		}

		// Watch for iternal widow resizes
		this.setupResizeObserver(view);

		// Update the input field position and scroll down after render
		setTimeout(() => {
		  this.updateChatInputPosition(view);
		  // TODO move to dedicated button?
		  scrollToBottom(view);
		}, 50);

	}

	async onload() {

		await this.loadSettings();
		this.applyStyles();
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
			/* Detect file switches and scroll to the bottom on chat files, update chat input position */

				this.app.workspace.on("active-leaf-change", async (leaf) => {
					await this.onFileSwitch(leaf);
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
			/* Detect yaml changes and refresh/rerender the file if it becomes or is no longer a chat note */

			this.app.metadataCache.on("changed", (file) => {
				
				if (!(file instanceof TFile)) return;
		
				// TODO always rerender if chat is true and markdown change is detected (visuals may have been overriden)
				const current = isChatFile(this.app, file);
				const prev = this.chatFileState.get(file.path);
				if (prev === current) return;
		
				this.chatFileState.set(file.path, current);
		
				// delay until UI + markdown settle
				setTimeout(() => {
					void this.refreshFile(file);
				}, 300); // timeout 300ms prevents error in embed link plugin.
			})
		);

		this.registerMarkdownCodeBlockProcessor(
			"chat-message",
			async (source, el, ctx) => {
				
				// Check if file is a chat
				const file = ctx.sourcePath
				? this.app.vault.getAbstractFileByPath(ctx.sourcePath)
				: null;
				if (!(file instanceof TFile)) return;

				// Parse codeblock to message
				const msg = Message.fromString(source);
				
				// Create HTML structure for message
				const {wrapper, content } = createElementsHTML({
					plugin: this,
					ctx,
					source,
					author_text: msg.header.author,
					timestamp_text: msg.header.timestamp,
					onToggle: this.handleMenuToggle.bind(this)
				});

				// Only render if file has type: chat
				const fs = this.chatFileState.get(file.path)
				const isChatNote = fs === undefined ? isChatFile(this.app, file) : fs;
				if (!isChatNote) {
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

				el.appendChild(wrapper);
			
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

	getChatInput(): HTMLElement {
		if (!this.chatInputEl) {
			this.chatInputEl = this.createChatInput();
		}
		return this.chatInputEl;
	}

	createChatInput(): HTMLElement {
		const container = createDiv("chat-input-container");
	
		this.chatTextareaEl = container.createEl("textarea", {
			cls: "chat-input"
		});
	
		this.chatTextareaEl.oninput = () => {
			if (this.currentFile) {
				this.inputState.set(this.currentFile.path, this.chatTextareaEl.value);
			}
		};
	
		const button = container.createEl("button");
		button.className = "chat-send-button";
		setIcon(button, "send");
	
		button.onclick = async () => {
			const file = this.app.workspace.getActiveFile();
			if (!file || !isChatFile(this.app, file)) return;
	
			const value = this.chatTextareaEl.value.trim();
			if (!value) return;
	
			await this.appendMessage(file, value);
	
			this.setInputValue("");
			this.inputState.set(file.path, "");
		};
	
		return container;
	}

	updateChatInputPosition(view: MarkdownView) {

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

	async appendMessage(file: TFile, content: string) {
		// TODO: create and save standart header for every chat? map?
		// const chat_header = new Header();
		// const msg = new Message(chat_header, content);
		await this.app.vault.append(file, "msg.toString()");

	}

	async refreshFile(file: TFile) {
		
		const leaves = this.app.workspace.getLeavesOfType("markdown");
	
		for (const leaf of leaves) {
			const view = leaf.view;
	
			if (!(view instanceof MarkdownView)) continue;
			if (view.file?.path !== file.path) continue;
	
			this.updateChatInputPosition(view);

			if (view.getMode() === "preview") {
				view.previewMode.rerender(true);
			} else {
				// editor in live preview (source mode)
				type RebuildableLeaf = WorkspaceLeaf & {
					rebuildView: () => Promise<void>;
				};
				
				await (leaf as RebuildableLeaf).rebuildView();
			}
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

	handleMenuToggle(menu: HTMLElement) {
		if (this.openMenu && this.openMenu !== menu) {
			this.openMenu.classList.remove("menu-open");
		}

		const isOpening = !menu.classList.contains("menu-open");
		menu.classList.toggle("menu-open");
		this.openMenu = isOpening ? menu : null;

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

	async loadSettings() {
		const data = (await this.loadData()) as Partial<ChatNotesPluginSettings> ?? {};
		
		this.settings = {
			...DEFAULT_SETTINGS,
			...data,
		};
	
		this.applyStyles();

	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.applyStyles();

	}		

	applyStyles() {
		document.documentElement.style.setProperty(
			"--settings-msg-bg-color",
			this.settings.messageBgColor
		);

		document.documentElement.style.setProperty(
			"--settings-msg-corner-radius",
			`${this.settings.messageCornerRadius}px`
		);

		const body = document.body;

		if (this.settings.enableButtonShadow) {
			body.classList.remove("menu-btn-no-shadow");
		} else {
			body.classList.add("menu-btn-no-shadow");
		}

	}

}

