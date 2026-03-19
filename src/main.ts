import { Plugin, MarkdownPostProcessorContext, MarkdownRenderer, setIcon, Notice } from "obsidian";



export default class DiscordChatPlugin extends Plugin {
	
	openMenu: HTMLElement | null = null;

	async onload() {

		this.registerMarkdownCodeBlockProcessor(
			"discord-message",
			async (source, el, ctx) => {
		  
			const lines = source.split("\n");
			const author_text = lines[0].replace("author:", "").trim();
			const timestamp_text = lines[1].replace("timestamp:", "").trim();
			const markdown = lines.slice(3).join("\n");
		
			const wrapper = document.createElement("div");
			wrapper.className = "discord-message";

			const content = document.createElement("div");
			content.className = "discord-content";

			/* Create Copy, Delete, Buttons */
			const {menu, menuBtn, buttonContainer} = createMessageActionsMenu();
	
			/* Create Header and add menu buttons to Header*/
			const header = createMessageHeader(`${author_text}`, `${timestamp_text}`, menu);
			
			wrapper.append(header, content);
			el.appendChild(wrapper);
			

			/* Event listner for menu button ------ */
			menuBtn.addEventListener("click", (e) => {
				e.stopPropagation();
			
				if (this.openMenu && this.openMenu !== menu) {
					this.openMenu.classList.remove("menu-open");
				}
			
				const isOpening = !menu.classList.contains("menu-open");
				menu.classList.toggle("menu-open");
				this.openMenu = isOpening ? menu : null;
			});

			document.addEventListener("click", () => {
				if (this.openMenu) {
					this.openMenu.classList.remove("menu-open");
					this.openMenu = null;
				}
			});

			buttonContainer.addEventListener("click", (e) => {
				e.stopPropagation();
			});

			await MarkdownRenderer.renderMarkdown(
			markdown,
			content,
			ctx.sourcePath,
			this
			);
			}
		  );
	
	
	}

}

function createMessageActionsMenu() {

	const menu = document.createElement("div");
	menu.className = "discord-message-menu";

	const buttonContainer = document.createElement("div");
	buttonContainer.className = "discord-message-buttons";
	
	const editBtn = document.createElement("button");
	editBtn.className = "discord-btn discord-edit-btn";
	setIcon(editBtn, "pencil");

	const deleteBtn = document.createElement("button");
	deleteBtn.className = "discord-btn discord-delete-btn";
	setIcon(deleteBtn, "trash");

	const copyBtn = document.createElement("button");
	copyBtn.className = "discord-btn discord-copy-btn";
	setIcon(copyBtn, "copy");

	const menuBtn = document.createElement("button");
	menuBtn.className = "discord-btn discord-menu-btn";
	setIcon(menuBtn, "menu");

	buttonContainer.append(editBtn, deleteBtn, copyBtn, menuBtn);
	menu.append(buttonContainer, menuBtn)

    return {
        menu,
        menuBtn,
		buttonContainer
    };
};

function createMessageHeader(authorText: string, timestampText: string, menu: HTMLDivElement): HTMLDivElement {
	const header = document.createElement("div");
	header.className = "discord-header";

	const meta = document.createElement("div");
	meta.className = "discord-header-meta";

	const author = document.createElement("span");
	author.className = "discord-author";
	author.textContent = authorText;

	const timestamp = document.createElement("span");
	timestamp.className = "discord-timestamp";
	timestamp.textContent = timestampText;

	meta.append(author, timestamp);
	header.append(meta, menu);

	return header
};
			