import { MarkdownRenderer, setIcon, Notice, TFile, MarkdownView } from "obsidian";
import { ConfirmDeleteModal } from "./modals" 
import { Message, CreateHTMLParams, CreateMenuParams } from "./types"
import { scrollDocument } from "./util"
import type ChatNotesPlugin from "./main";


export function createChatInput(plugin: ChatNotesPlugin) {
	const container = createDiv("chat-input-container");

	const textarea = container.createEl("textarea", {
		cls: "chat-input"
	});

	textarea.oninput = () => {
		if (plugin.currentFile) {
			plugin.getChatNote(plugin.currentFile).inputCache = textarea.value;
		}
	};

	const button = container.createEl("button");
	button.className = "chat-send-button";
	setIcon(button, "send");

	button.onclick = async () => {
		const file = plugin.app.workspace.getActiveFile();
		if (!file || !plugin.getIsChatNote(file)) return;

		const value = textarea.value.trim();
		if (!value) return;

		await plugin.appendMessage(file, value);

		textarea.value = "";
		plugin.getChatNote(file).inputCache = "";
	};

	return {
		container,
		textarea
	};
}


export function addScrollButtons(view: MarkdownView) {
	
	// const view = this.app.workspace.getActiveViewOfType(MarkdownView);
	if (!view) return;

	// Avoid adding multiple times
	if ((view as any)._scrollButtonAdded) return;
	(view as any)._scrollButtonAdded = true;

	view.addAction("arrow-up", "Scroll to top", (evt) => {
		scrollDocument(view, "top")
	});

	view.addAction("arrow-down", "Scroll to bottom", (evt) => {
		scrollDocument(view, "bottom")
	});
}

/**
Create HTML elements for messages
*/
export function createElementsHTML({plugin, ctx, msg, author_text, onToggle, onHighlight} : CreateHTMLParams){

	const wrapper = document.createElement("div");
	wrapper.className = "chat-message";
	const content = document.createElement("div");
	content.className = "message-content";

	/* Create Action Menu with Copy, Delete and Edit Button */
	const { menu } = createMessageActionsMenu({
		plugin,
		ctx,
		msg,
		wrapper,
		content,
		onToggle,
		onHighlight
	});

	/* Create message header and add menu buttons to header */
	const header = createMessageHeader(`${author_text}`, `${msg.header.timestamp}`,  menu);
	wrapper.append(header, content);

	return {
		wrapper,
		content
	}
}

function createMessageActionsMenu({
	plugin,
	ctx,
	msg,
	wrapper,
	content,
	onToggle,
	onHighlight
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

	const favBtn = document.createElement("button");
	favBtn.className = "msg-action-btn msg-fav-btn";
	setIcon(favBtn, "pin");
	favBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		onHighlight(msg.header.id, true);
	});

	buttonContainer.append(editBtn, deleteBtn, copyBtn, favBtn, menuBtn);
	menu.append(buttonContainer, menuBtn)

    /* ---------------- COPY ---------------- */
    copyBtn.addEventListener("click", () => {
		void (async () => {
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
