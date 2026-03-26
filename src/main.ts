import { Plugin, MarkdownRenderer, setIcon, Notice, PluginSettingTab, Setting, TFile, App, MarkdownView } from "obsidian";
import { ConfirmDeleteModal } from "./modals" 
import { Message, CreateHTMLParams, CreateMenuParams } from "./types"
import { DEFAULT_SETTINGS, ChatNotesPluginSettings, ChatNotesSettingTab } from "./settings"


export default class ChatNotesPlugin extends Plugin {
	
	openMenu: HTMLElement | null = null;
	settings: ChatNotesPluginSettings;
	activeEditor: {
		container: HTMLElement;
		restore: () => void;
	} | null = null;

	async onload() {

		await this.loadSettings();
		this.applyStyles();
		this.addSettingTab(new ChatNotesSettingTab(this.app, this));

		this.registerMarkdownCodeBlockProcessor(
			"chat-message",
			async (source, el, ctx) => {
		  
				// get message from file
				const msg = Message.fromString(source);

				// Create HTML structure for the message
				const {wrapper, content } = createElementsHTML({
					plugin: this,
					ctx,
					source,
					author_text: msg.header.author,
					timestamp_text: msg.header.timestamp,
					onToggle: this.handleMenuToggle.bind(this)
				});

				el.appendChild(wrapper);

				// TODO include in CallbacK and move to create actions?
				document.addEventListener("click", () => {
					if (this.openMenu) {
						this.openMenu.classList.remove("menu-open");
						this.openMenu = null;
					}
				});

				// Render message content as markdown
				await MarkdownRenderer.render(
					this.app,
					msg.content,
					content,
					ctx.sourcePath,
					this
				);
			}
		);
	}

	handleMenuToggle(menu: HTMLElement) {
		if (this.openMenu && this.openMenu !== menu) {
			this.openMenu.classList.remove("menu-open");
		}

		const isOpening = !menu.classList.contains("menu-open");
		menu.classList.toggle("menu-open");
		this.openMenu = isOpening ? menu : null;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
    copyBtn.addEventListener("click", async () => {
		const msg = Message.fromString(source);
        await navigator.clipboard.writeText(msg.content);
		new Notice("Copied Message");
    });


    /* ---------------- DELETE ---------------- */
	deleteBtn.addEventListener("click", async (e) => {
		e.stopPropagation();
	
		new ConfirmDeleteModal(app, async () => {
	
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
	
			new Notice("Deleted Message");
	
		}).open();
	});

	/* ---------------- EDIT ---------------- */
	editBtn.addEventListener("click", async (e) => {
		e.stopPropagation();
	
		const editor = app.workspace.getActiveViewOfType(MarkdownView)?.editor;

		const file = app.vault.getAbstractFileByPath(filePath);
		if (!file) return;
		if (!(file instanceof TFile)) return;

		const section = ctx.getSectionInfo(wrapper);
		if (!section) return;
	
		/* ---------------- GET CURRENT MESSAGE ---------------- */
		let fileContent = await app.vault.read(file);
		const lines = fileContent.split("\n");

		const blockLines = lines.slice(
			section.lineStart,
			section.lineEnd + 1
		);

		// --- validate wrapper ---
		if (blockLines[0] !== "````chat-message") {
			throw new Error("Missing opening ````chat-message");
		}
		if (blockLines[blockLines.length - 1] !== "````") {
			throw new Error("Missing closing ````");
		}

		// remove wrapper, create Message
		const inner = blockLines.slice(1, -1).join("\n");
		const msg = Message.fromString(inner);
	
		/* ---------------- CREATE EDITOR ---------------- */
		const textarea = document.createElement("textarea");
		textarea.className = "msg-inline-editor";
		textarea.value = msg.content;

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
	
		/* ---------------- SWITCH UI ---------------- */
		const originalContent = content.cloneNode(true);
		content.empty();
		content.appendChild(editorWrapper);
		textarea.focus();

		/* Auto resize the editor depending of the amount of content*/
		const autoResize = () => {
			textarea.style.height = "auto";
			textarea.style.height = textarea.scrollHeight + "px";
		};
		textarea.addEventListener("input", autoResize);
		autoResize();
	
		/* ---------------- CANCEL ---------------- */
		cancelBtn.addEventListener("click", () => {
			content.empty();
			content.appendChild(originalContent);
		});
	
		/* ---------------- SAVE ---------------- */
		saveBtn.addEventListener("click", async () => {

			const newContent = textarea.value
			const newMarkdown = msg.setContent(newContent).toString();

			lines.splice(
				section.lineStart,
				section.lineEnd - section.lineStart + 1,
				newMarkdown
			);
			
			if (editor){
				editor.setValue(lines.join("\n"));
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
				plugin
			);
		});

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
