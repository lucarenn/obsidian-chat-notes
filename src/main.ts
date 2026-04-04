import { Plugin, MarkdownRenderer, setIcon, Notice, TFile, App, MarkdownView, WorkspaceLeaf } from "obsidian";
import { ConfirmDeleteModal } from "./modals" 
import { Message, Header, CreateHTMLParams, CreateMenuParams } from "./types"
import { DEFAULT_SETTINGS, ChatNotesPluginSettings, ChatNotesSettingTab } from "./settings"

function isChatFile(app: App, file: TFile): boolean {
	const cache = app.metadataCache.getFileCache(file);
	return cache?.frontmatter?.type === "chat";
}

export default class ChatNotesPlugin extends Plugin {
	
	openMenu: HTMLElement | null = null;
	settings: ChatNotesPluginSettings;

	activeEditor: {
		container: HTMLElement;
		restore: () => void;
	} | null = null;

	private chatFileState = new Map<string, boolean>();
	chatInputEl: HTMLElement;
	chatTextareaEl: HTMLTextAreaElement;

	async refreshFile(file: TFile) {
		
		console.log("File refresh");
		const leaves = this.app.workspace.getLeavesOfType("markdown");
	
		for (const leaf of leaves) {
			const view = leaf.view;
	
			if (!(view instanceof MarkdownView)) continue;
			if (view.file?.path !== file.path) continue;
	
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
	
	scrollToBottom(view: MarkdownView) {
		console.log("scrolled")
		const container = view.containerEl.querySelector(".markdown-preview-view");
		if (!container) return;

		const cmScroller = view.containerEl.querySelector(".cm-scroller");
		cmScroller?.scrollTo({ top: cmScroller.scrollHeight });
		
		container.scrollTop = container.scrollHeight;
	}

	async onload() {

		await this.loadSettings();
		this.applyStyles();
		this.addSettingTab(new ChatNotesSettingTab(this.app, this));

		document.addEventListener("click", (event) => {
			/* Detect clicks outside a message action menu and closes the current open menu */

			if (!this.openMenu) return;
			const target = event.target as HTMLElement;
	
			if (!this.openMenu.contains(target)) {
				this.openMenu.classList.remove("menu-open");
				this.openMenu = null;
			}
		});

		this.registerEvent(
			/* Detect file switches and scroll to the bottom on chat files */

				this.app.workspace.on("active-leaf-change", async (leaf) => {
					console.log("File switch")
				if (!leaf) return;
			
				const view = leaf.view;
				if (!(view instanceof MarkdownView)) return;
			  
				const file = view.file; // <-- active file
				if (!file) return;
				if (!isChatFile(this.app, file)) return;
			
				// Delay to ensure rendering is complete
				setTimeout(() => {
					this.scrollToBottom(view);
					}, 50);
				})
		  );

		/*
		this.registerEvent(
		this.app.workspace.on("active-leaf-change", () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			const file = this.app.workspace.getActiveFile();

			if (!view || !file || !isChatFile(this.app, file)) {
			this.chatInputEl.style.display = "none";
			return;
			}

			this.chatInputEl.style.display = "flex";

			// Move into correct container
			view.containerEl.appendChild(this.chatInputEl);
		})
		); */

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
			  const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			  if (!view) return;
			  setTimeout(() => this.updateChatInputPosition(view), 50);
			})
		  );
		  
		window.addEventListener("resize", () => {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		this.updateChatInputPosition(view);
		});
		
		this.registerEvent(
			/* Detect yaml changes and refresh/rerender the file if it becomes or is no longer a chat note */

			this.app.metadataCache.on("changed", (file) => {
				
				console.log("Yaml change detected");
				if (!(file instanceof TFile)) return;
		
				// TODO always rerender if chat is true and markdown change is detected
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
				console.log(" view found")
				this.createChatInput(view);
			  	this.updateChatInputPosition(view);
			} else {
				console.log("No view found")
			}
		  });
	}

	onunload() {
		this.chatInputEl?.remove();
	}

	createChatInput(view: MarkdownView) {

		this.chatInputEl = createDiv("chat-input-container");
		// const container = getContentContainer(view);
		// if (!container) {
		// 	console.log("no container found")
		// 	return
		// }
		// container.appendChild(this.chatInputEl);
		document.body.appendChild(this.chatInputEl);

		this.chatTextareaEl = this.chatInputEl.createEl("textarea", {
			cls: "chat-input"
		});
	
		const button = this.chatInputEl.createEl("button");
		button.className = "chat-send-button";
		setIcon(button, "send");
	
		button.onclick = async () => {
			const file = this.app.workspace.getActiveFile();
			if (!file || !isChatFile(this.app, file)) return;
		
			const value = this.chatTextareaEl.value.trim();
			if (!value) return;
		
			await this.appendMessage(file, value);
			this.chatTextareaEl.value = "";
		};

	}

	updateChatInputPosition(view: MarkdownView) {

		const metrics = getContentMetrics(view);
		if (!metrics) return;
	
		this.chatInputEl.style.position = "fixed";
		this.chatInputEl.style.bottom = "0px";

		let width = metrics.width
		let left = metrics.left

		// set default values when in reading mode
		if (!width  || width === 0) width = 700;
		if (!left  || left === 0) left = 626;

		this.chatInputEl.style.width = `${width}px`;
		this.chatInputEl.style.left = `${left}px`;

	}

	async appendMessage(file: TFile, content: string) {
		// TODO: create and save standart header for every chat? map?
		// const chat_header = new Header();
		// const msg = new Message(chat_header, content);
		await this.app.vault.append(file, "msg.toString()");

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
			console.log("Same editor")
			return;
		}
	
		// Close previous editor
		if (this.activeEditor) {
			console.log("different editor")
			
			console.log(newEditor.container)
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



function getContentMetrics(view: MarkdownView) {
	const el =
	  view.containerEl.querySelector(".cm-contentContainer") ||
	  view.containerEl.querySelector(".markdown-preview-sizer");
  
	if (!el) return null;
  
	const rect = el.getBoundingClientRect();
  
	return {
	  width: rect.width,
	  left: rect.left
	};
}

function createElementsHTML({plugin, ctx, source, author_text, timestamp_text, onToggle} : CreateHTMLParams){
	/*
	Create Message HTML Elements
	*/

	const wrapper = document.createElement("div");
	wrapper.className = "chat-message";
	const content = document.createElement("div");
	content.className = "message-content";

	/* Create Action Menu with Copy, Delete and Edit Button */
	const { menu } = createMessageActionsMenu({
		plugin,
		ctx,
		source,
		wrapper,
		content,
		onToggle
	});

	/* Create Header and add menu buttons to Header */
	const header = createMessageHeader(`${author_text}`, `${timestamp_text}`, menu);
	wrapper.append(header, content);

	return {
		wrapper,
		content
	}
}

function createMessageActionsMenu({
	plugin,
	ctx,
	source,
	wrapper,
	content,
	onToggle,
} : CreateMenuParams) {
	

    const filePath = ctx.sourcePath;
	const app = plugin.app;

	const menu = document.createElement("div");
	menu.className = "msg-action-menu";

	const buttonContainer = document.createElement("div");
	buttonContainer.className = "msg-action-btn-container";
	buttonContainer.addEventListener("click", (e) => {
		e.stopPropagation();
	});

	const editBtn = document.createElement("button");
	editBtn.className = "msg-action-btn msg-edit-btn";
	setIcon(editBtn, "pencil");

	const deleteBtn = document.createElement("button");
	deleteBtn.className = "msg-action-btn msg-delete-btn";
	setIcon(deleteBtn, "trash");

	const copyBtn = document.createElement("button");
	copyBtn.className = "msg-action-btn msg-copy-btn";
	setIcon(copyBtn, "copy");

	const menuBtn = document.createElement("button");
	menuBtn.className = "msg-action-btn msg-menu-btn";
	setIcon(menuBtn, "menu");
	menuBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		onToggle(menu);
	});

	buttonContainer.append(editBtn, deleteBtn, copyBtn, menuBtn);
	menu.append(buttonContainer, menuBtn)


    /* ---------------- COPY ---------------- */
    copyBtn.addEventListener("click", () => {
		void (async () => {
			const msg = Message.fromString(source);
			await navigator.clipboard.writeText(msg.content);
			new Notice("Copied message");

		})();
    });


    /* ---------------- DELETE ---------------- */
	deleteBtn.addEventListener("click", (e) => {

		void (async () => {

			e.stopPropagation();
	
			new ConfirmDeleteModal(app, () => {

				void (async () => {
					const editor = app.workspace.getActiveViewOfType(MarkdownView)?.editor;
		
					const file = app.vault.getAbstractFileByPath(filePath);
					if (!file) return;
					if (!(file instanceof TFile)) return;
		
					const section = ctx.getSectionInfo(wrapper);
					if (!section) return;
			
					let content = await app.vault.read(file);
					const lines = content.split("\n");
			
					lines.splice(
						section.lineStart,
						section.lineEnd - section.lineStart + 1
					);
			
					if (editor){
						editor.setValue(lines.join("\n"));
					} else {
						await app.vault.modify(file, lines.join("\n"));
					}
			
					new Notice("Deleted message");

				})();
			}).open();
		})();
	});

	/* ---------------- EDIT ---------------- */
	editBtn.addEventListener("click", (e) => {

		void (async () => {
				e.stopPropagation();

				// return if this editor is currently already open
				if (plugin.activeEditor?.container === content.firstChild) {
					console.log("editor is already open")
					return;
				}
				
				const editor = app.workspace.getActiveViewOfType(MarkdownView)?.editor;

				const file = app.vault.getAbstractFileByPath(filePath);
				if (!file) return;
				if (!(file instanceof TFile)) return;

				const section = ctx.getSectionInfo(wrapper);
				if (!section) return;
			
				// Get current Message
				let fileContent = await app.vault.read(file);
				const lines = fileContent.split("\n");

				const blockLines = lines.slice(
					section.lineStart,
					section.lineEnd + 1
				);

				// Validate Wrapper
				if (blockLines[0] !== "````chat-message") {
					throw new Error("Missing opening ````chat-message");
				}
				if (blockLines[blockLines.length - 1] !== "````") {
					throw new Error("Missing closing ````");
				}

				// Remove wrapper, create Message
				const inner = blockLines.slice(1, -1).join("\n");
				const msg = Message.fromString(inner);
			
				// Create Editor
				const textarea = document.createElement("textarea");
				textarea.className = "msg-inline-editor";
				textarea.value = msg.content;

				// eslint-disable-next-line obsidianmd/no-static-styles-assignment
				textarea.style.height = "auto";
				textarea.style.height = textarea.scrollHeight + "px";

				const saveBtn = document.createElement("button");
				saveBtn.textContent = "Save";
				saveBtn.className = "msg-btn msg-editor-save-btn";
			
				const cancelBtn = document.createElement("button");
				cancelBtn.textContent = "Cancel";
				cancelBtn.className = "msg-btn msg-editor-cancel-btn";
			
				const btnRow = document.createElement("div");
				btnRow.className = "msg-editor-buttons";
				btnRow.append(saveBtn, cancelBtn);

				const editorWrapper = document.createElement("div");
				editorWrapper.className = "msg-editor-wrapper";
				editorWrapper.append(textarea, btnRow)
			

				// Cancel editor changes
				const restore = () => {
					content.empty();
					content.appendChild(originalContent);
					plugin.clearActiveEditor({ container: editorWrapper });
				};

				// Cancel current editor first
				plugin.handleOpenEditor({
					container: editorWrapper,
					restore
				});
	
				// Switch UI
				const originalContent = content.cloneNode(true);
				content.empty();
				content.appendChild(editorWrapper);
				textarea.focus();

				/* Auto resize the editor depending of the amount of content*/
				const autoResize = () => {
					// eslint-disable-next-line obsidianmd/no-static-styles-assignment
					textarea.style.height = "auto";
					textarea.style.height = textarea.scrollHeight + "px";
				};
				textarea.addEventListener("input", autoResize);
				autoResize();
			
				// Cancel Action
				cancelBtn.addEventListener("click", () => {
					restore();
				});
			
				// Save Action
				saveBtn.addEventListener("click", () => {

					void (async () => {
						const newContent = textarea.value
						const newMarkdown = msg.setContent(newContent).toString();

						lines.splice(
							section.lineStart,
							section.lineEnd - section.lineStart + 1,
							newMarkdown
						);
						


						if (editor){

							// changes whole document = inefficient + triggers yaml changes (rerender)
							// editor.setValue(lines.join("\n"));
							console.log(
								{ line: section.lineStart, ch: 0 },
								{ line: section.lineEnd + 1, ch: 0 }
							)
							editor.replaceRange(
								newMarkdown,
								{ line: section.lineStart, ch: 0 },
								{ line: section.lineEnd +1, ch: 0 }
							);

						} else {
							await app.vault.modify(file, lines.join("\n"));
						}

						// instant UI update
						content.empty();

						await MarkdownRenderer.render(
							app,
							newContent,
							content,
							filePath,
							// eslint-disable-next-line obsidianmd/no-plugin-as-component
							plugin
						);

						// clear the active editor
						plugin.clearActiveEditor({ container: editorWrapper });
					})();

				});
			})();
		});

	return {
		menu,
		wrapper,
		content
	};
};

function createMessageHeader(authorText: string, timestampText: string, menu: HTMLDivElement): HTMLDivElement {
	const header = document.createElement("div");
	header.className = "msg-header";

	const meta = document.createElement("div");
	meta.className = "msg-header-meta";

	const author = document.createElement("span");
	author.className = "msg-author";
	author.textContent = authorText;

	const timestamp = document.createElement("span");
	timestamp.className = "msg-timestamp";
	timestamp.textContent = timestampText;

	meta.append(author, timestamp);
	header.append(meta, menu);

	return header
};
