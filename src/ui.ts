import { MarkdownRenderer, MarkdownRenderChild, MarkdownPostProcessorContext, setIcon, Notice, TFile, MarkdownView, Scope } from "obsidian";
import { ConfirmDeleteModal } from "./modals"
import { Message, MessageEntry, CreateHTMLParams, CreateMenuParams } from "./types"
import { scrollDocument } from "./util"
import type ChatNotesPlugin from "./main";


export function createChatInput(plugin: ChatNotesPlugin) {
	const container = createDiv("chat-input-container");

	/* Banner shown above the input row while a reply is pending; hidden (and removed
	   from layout) whenever there is no active reply target. */
	const replyBanner = container.createDiv("chat-input-reply-banner");

	const replyIcon = replyBanner.createSpan("chat-input-reply-banner-icon");
	setIcon(replyIcon, "corner-up-left");

	const replyText = replyBanner.createSpan("chat-input-reply-banner-text");

	const replyCancelBtn = replyBanner.createEl("button", {
		cls: "chat-input-reply-cancel-btn"
	});
	replyCancelBtn.type = "button";
	replyCancelBtn.setAttribute("aria-label", "Cancel reply");
	setIcon(replyCancelBtn, "x");
	replyCancelBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		void plugin.handleCancelReply();
	});

	/* Row holding the textarea and send button, kept separate from the container so the
	   reply banner can sit above it without disturbing their existing flex layout. */
	const inputRow = container.createDiv("chat-input-row");

	const textarea = inputRow.createEl("textarea", {
		cls: "chat-input"
	});

	const resizeInput = () => {
		const maxHeight = plugin.settings.inputMaxHeight;
		// eslint-disable-next-line obsidianmd/no-static-styles-assignment
		textarea.style.height = "auto";
		// eslint-disable-next-line obsidianmd/no-static-styles-assignment
		textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
	};

	textarea.oninput = () => {
		if (plugin.currentFile) {
			plugin.getChatNote(plugin.currentFile).inputCache = textarea.value;
		}
		resizeInput();
	};

	// set the baseline height immediately, so the field isn't collapsed
	// for an instant when first created (before any input is entered)
	resizeInput();

	const sendMessage = async () => {
		const file = plugin.app.workspace.getActiveFile();
		if (!file || !plugin.getIsChatNote(file)) return;

		const value = textarea.value.trim();
		if (!value) return;

		await plugin.appendMessage(file, value);

		textarea.value = "";
		plugin.getChatNote(file).inputCache = "";
		resizeInput();

		// a pending reply only applies to the message it was just sent with
		void plugin.handleCancelReply();
	};

	// Obsidian's global hotkey scope can swallow "Mod+Enter" before it ever
	// reaches a plain keydown listener (e.g. if some other command already
	// claims that combo). Registering our own scope and pushing it while
	// the input is focused makes our binding take priority instead.
	const sendScope = new Scope(plugin.app.scope);
	sendScope.register(["Mod"], "Enter", () => {
		void sendMessage();
		return false; // auto preventDefault, stops a newline from being inserted
	});
	textarea.addEventListener("focus", () => plugin.app.keymap.pushScope(sendScope));
	textarea.addEventListener("blur", () => plugin.app.keymap.popScope(sendScope));

	const button = inputRow.createEl("button");
	button.className = "chat-send-button";
	setIcon(button, "send");
	button.onclick = sendMessage;

	return {
		container,
		textarea,
		replyBanner,
		replyText
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


export function addPinButton(view: MarkdownView, onPress: ()=>void) {
	
	// const view = this.app.workspace.getActiveViewOfType(MarkdownView);
	if (!view) return;

	// Avoid adding multiple times
	if ((view as any)._pinButtonAdded) return;
	(view as any)._pinButtonAdded = true;

	view.addAction("pin", "Show Pinned Messages", async (evt) => {
		await onPress();
	});

}

export function addScrollMsgButton(view: MarkdownView,
	file: TFile,
	msgId: string,
	onScroll: (file: TFile, id:  string)=>void) {
	
	// const view = this.app.workspace.getActiveViewOfType(MarkdownView);
	if (!view) return;
	if ((view as any)._msgScrollButtonAdded) return;
	(view as any)._msgScrollButtonAdded = true;

	view.addAction("pin", "Scroll to Message: " + msgId,  (evt) => {
		onScroll(file, msgId);
	});

}

/**
Create HTML elements for messages
*/
export function createElementsHTML({plugin, ctx, msg, author_text, context, isReplyTarget, onToggle, onHighlight, onReplyToggle, onScrollToReply} : CreateHTMLParams){

	// row reserves a fixed gutter (via wrapper's margin-right, see styles.css) so the
	// reply button always has room inside the row's own box - it never needs to escape
	// into space outside the message column, which isn't reliably clipping-free across
	// reading view / live preview / window widths. Hover is bound to the row (not just
	// the bubble) so the whole bubble+gutter+button strip is one continuous hover zone.
	const row = document.createElement("div");
	row.className = "chat-message-row";

	const wrapper = document.createElement("div");
	wrapper.className = "chat-message";
	wrapper.classList.toggle("chat-message-reply-target", isReplyTarget);

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

	/* Seamless banner shown when this message is a reply to another one */
	const replyTargetId = msg.header.extra.reply_to;
	if (replyTargetId) {
		console.log("MEssage Reply")
		const replyTargetEntry = context.messageMap.get(replyTargetId);
		if (replyTargetEntry) {
			const banner = createReplyBanner(replyTargetEntry, () => onScrollToReply(replyTargetId));
			wrapper.append(banner);
		}
	}

	wrapper.append(header, content);

	/* Hover button, spans the full message height in the reserved gutter (see styles.css).
	   The icon's own position is kept on screen while scrolling via attachStickyReplyIcon
	   below, instead of disappearing along with the message top. */
	const replyBtn = document.createElement("button");
	replyBtn.className = "msg-reply-btn";
	replyBtn.type = "button";
	replyBtn.setAttribute("aria-label", "Reply to message");
	replyBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		onReplyToggle(msg.header.id);
	});

	const replyBtnIcon = document.createElement("span");
	replyBtnIcon.className = "msg-reply-btn-icon";
	setIcon(replyBtnIcon, "reply");
	replyBtn.append(replyBtnIcon);

	attachStickyReplyIcon(row, replyBtn, replyBtnIcon, ctx);

	row.append(wrapper, replyBtn);

	return {
		wrapper,
		content,
		row
	}
}

/* Manually reproduces `position: sticky` for the reply icon via scroll tracking. CSS
   sticky alone works in Reading View but goes inert in Live Preview, where Obsidian
   mounts each message as a CodeMirror block widget nested inside flex containers
   (.cm-sizer/.cm-scroller) rather than Reading View's flat DOM - tracking the scroll
   position by hand sidesteps that ancestor chain entirely, so the icon behaves
   identically in both view modes. Only active while the row is actually hovered
   (i.e. while the button is visible), so idle messages carry no listener overhead. */
function attachStickyReplyIcon(row: HTMLElement, btn: HTMLElement, icon: HTMLElement, ctx: MarkdownPostProcessorContext) {

	let scroller: Element | null = null;
	let rafId: number | null = null;

	const update = () => {
		rafId = null;
		if (!scroller) return;

		const scrollerRect = scroller.getBoundingClientRect();
		const rowRect = row.getBoundingClientRect();
		const OFFSET = 16;
		// keeps the icon from ever resting flush against the message's own top edge,
		// clear of Reading View's code-block "edit" button in that same corner
		const TOP_INSET = 18;

		const min = rowRect.top + TOP_INSET;
		const max = rowRect.bottom - icon.offsetHeight;
		const target = Math.min(Math.max(scrollerRect.top + OFFSET, min), max);

		icon.style.transform = `translateY(${target - rowRect.top}px)`;
	};

	const scheduleUpdate = () => {
		if (rafId !== null) return;
		rafId = requestAnimationFrame(update);
	};

	const start = () => {
		scroller = row.closest(".cm-scroller, .markdown-preview-view");
		if (!scroller) return;

		scroller.addEventListener("scroll", scheduleUpdate, { passive: true });
		window.addEventListener("resize", scheduleUpdate, { passive: true });
		update();
	};

	const stop = () => {
		if (rafId !== null) {
			cancelAnimationFrame(rafId);
			rafId = null;
		}
		scroller?.removeEventListener("scroll", scheduleUpdate);
		window.removeEventListener("resize", scheduleUpdate);
		scroller = null;
		icon.style.transform = "";
	};

	row.addEventListener("mouseenter", start);
	row.addEventListener("mouseleave", stop);

	// safety net: guarantees the scroll/resize listeners are torn down if the row is
	// destroyed mid-hover (e.g. a full note re-render) without a mouseleave ever firing
	const child = new MarkdownRenderChild(btn);
	child.onunload = stop;
	ctx.addChild(child);
}

function createReplyBanner(targetEntry: MessageEntry, onScroll: () => void): HTMLDivElement {

	const banner = document.createElement("div");
	banner.className = "msg-reply-banner";
	banner.setAttribute("role", "button");
	banner.tabIndex = 0;

	const icon = document.createElement("span");
	icon.className = "msg-reply-banner-icon";
	setIcon(icon, "corner-up-left");

	const text = document.createElement("span");
	text.className = "msg-reply-banner-text";

	const author = targetEntry.message.header.author || "Unknown";
	const preview = targetEntry.message.content.trim().replace(/\s+/g, " ").slice(0, 80);
	text.textContent = preview ? `${author}: ${preview}` : author;

	banner.append(icon, text);

	const scroll = (e: Event) => {
		e.stopPropagation();
		onScroll();
	};
	banner.addEventListener("click", scroll);
	banner.addEventListener("keydown", (e) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			onScroll();
		}
	});

	return banner;
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
			
			copyBtn.classList.add("fade");
			setTimeout(() => {
				setIcon(copyBtn, "checkmark");
				copyBtn.classList.remove("fade");
			}, 150);

			let resetTimer = Number(msg.header.id);
			clearTimeout(resetTimer);

			resetTimer = window.setTimeout(() => {
				copyBtn.classList.add("fade");
				setTimeout(() => {
					setIcon(copyBtn, "copy");
					copyBtn.classList.remove("fade");
				}, 180);
			}, 1100);

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

async function copyHeaderText(text: string, noticeText: string) {
	await navigator.clipboard.writeText(text);
	new Notice(noticeText);
}

function createMessageHeader(authorText: string, timestampText: string, menu: HTMLDivElement): HTMLDivElement {

	const header = document.createElement("div");
	header.className = "msg-header";

	const meta = document.createElement("div");
	meta.className = "msg-header-meta";

	const author = document.createElement("button");
	author.type = "button";
	author.className = "msg-author";
	author.textContent = authorText;
	author.setAttribute("aria-label", "Copy author");
	author.addEventListener("click", (e) => {
		e.stopPropagation();
		void copyHeaderText(authorText, "Copied author");
	});

	const timestamp = document.createElement("button");
	timestamp.type = "button";
	timestamp.className = "msg-timestamp";
	timestamp.textContent = timestampText;
	timestamp.setAttribute("aria-label", "Copy date");
	timestamp.addEventListener("click", (e) => {
		e.stopPropagation();
		void copyHeaderText(timestampText, "Copied date");
	});

	meta.append(author, timestamp);
	header.append(meta, menu);

	return header
};
