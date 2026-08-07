import { MarkdownRenderer, MarkdownRenderChild, MarkdownPostProcessorContext, setIcon, Notice, TFile, MarkdownView, Scope } from "obsidian";
import { ConfirmDeleteModal } from "./modals"
import { Message, MessageEntry, CreateHTMLParams, CreateMenuParams } from "./types"
import { scrollDocument, isValidTimestamp, TIMESTAMP_PLACEHOLDER } from "./util"
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

	/* Collapsible header row, letting the user override the author/timestamp the next
	   sent message is written with. Collapsed to just a slim "···" affordance so it stays
	   out of the way while typing; see the reveal wiring below for when it opens. */
	const headerArea = container.createDiv("chat-input-header-area");

	const expander = headerArea.createEl("button", {
		cls: "chat-input-expander"
	});
	expander.type = "button";
	expander.textContent = "···";
	expander.setAttribute("aria-label", "Message header options");
	expander.setAttribute("aria-expanded", "false");

	const extraRow = headerArea.createDiv("chat-input-extra-row");

	/* Native <input list=...> combobox: accepts a brand new name as free text while
	   offering the file's existing authors as a dropdown, rather than forcing a choice
	   between the two. */
	const authorField = extraRow.createDiv("chat-input-extra-field");
	authorField.createEl("label", {
		cls: "chat-input-extra-label",
		text: "Author"
	});

	const authorInput = authorField.createEl("input", {
		cls: "chat-input-extra-input"
	});
	authorInput.type = "text";

	const authorList = authorField.createEl("datalist");
	authorList.id = `chat-author-list-${Date.now().toString(36)}`;
	authorInput.setAttribute("list", authorList.id);

	const timeField = extraRow.createDiv("chat-input-extra-field chat-input-extra-field-time");
	timeField.createEl("label", {
		cls: "chat-input-extra-label",
		text: "Time"
	});

	const timeInput = timeField.createEl("input", {
		cls: "chat-input-extra-input"
	});
	timeInput.type = "text";
	timeInput.placeholder = TIMESTAMP_PLACEHOLDER;

	/* Holds the row open past the hover in the two cases where collapsing it would fight
	   the user: while something inside has focus (the author dropdown would otherwise
	   vanish the moment the mouse left the row) and while either field holds a value, so
	   a pending override is never hidden from the person who typed it. */
	const updateHeaderAreaState = () => {
		const hasValue =
			authorInput.value.trim() !== "" || timeInput.value.trim() !== "";
		// the fields only, not the whole area: clicking the "···" button focuses it, and
		// counting that as focus would make the button read its own click as a sticky
		// open state and answer it with a dismissal every time (see expander.onclick)
		const hasFocus = extraRow.contains(document.activeElement);

		headerArea.classList.toggle("is-active", hasValue || hasFocus);
	};

	const setHeaderAreaPinned = (pinned: boolean) => {
		headerArea.classList.toggle("is-pinned", pinned);
		expander.setAttribute("aria-expanded", String(pinned));
	};

	/* Dismissal: the counterpart to .is-active, letting the user close a row that a typed
	   override would otherwise hold open forever - without clearing what was typed, which
	   stays live and still applies to the next message sent. Hover keeps working as a peek
	   at the pending values while dismissed. */
	const setHeaderAreaCollapsed = (collapsed: boolean) => {
		headerArea.classList.toggle("is-collapsed", collapsed);
		if (!collapsed) headerArea.classList.remove("is-dismissing");
	};

	/* Dismissing by click happens with the pointer necessarily inside the area, where the
	   hover peek would otherwise keep the row open and make the button look inert. This
	   suspends the peek for exactly that stretch, so the row shuts under the mouse. */
	headerArea.addEventListener("pointerleave", () =>
		headerArea.classList.remove("is-dismissing"));

	expander.onclick = (e) => {
		e.stopPropagation();

		/* Clicking while the row is held open by anything other than the hover itself reads
		   as "close this", since the hover already shows it - so the button only ever pins
		   when there is nothing to dismiss. */
		const stickyOpen =
			headerArea.classList.contains("is-pinned") ||
			headerArea.classList.contains("is-active");

		if (headerArea.classList.contains("is-collapsed")) {
			setHeaderAreaCollapsed(false);
			setHeaderAreaPinned(true);
			return;
		}

		if (stickyOpen) {
			setHeaderAreaPinned(false);
			setHeaderAreaCollapsed(true);
			headerArea.classList.add("is-dismissing");
			// a focused field inside the now-hidden row would swallow every keystroke
			if (extraRow.contains(document.activeElement)) textarea.focus();
			return;
		}

		setHeaderAreaPinned(true);
	};

	headerArea.addEventListener("focusin", updateHeaderAreaState);
	// focusout fires before the next element takes focus, so re-check on the following tick
	headerArea.addEventListener("focusout", () => window.setTimeout(updateHeaderAreaState, 0));

	authorInput.addEventListener("input", updateHeaderAreaState);

	timeInput.addEventListener("input", () => {
		const value = timeInput.value.trim();
		// flagged, never rejected - an odd timestamp still beats blocking the send
		timeInput.classList.toggle("is-invalid", value !== "" && !isValidTimestamp(value));
		updateHeaderAreaState();
	});

	/* Suggestions and the placeholder (which advertises the author that sending right now
	   would use) are pulled fresh each time the row opens: both shift as messages are
	   added, files switched, or YAML overrides edited, and this is the only moment either
	   is actually on screen. */
	const refreshHeaderFields = async () => {
		const file = plugin.app.workspace.getActiveFile();
		if (!file || !plugin.getIsChatNote(file)) return;

		const context = await plugin.getArchiveContext(file);

		authorList.empty();
		for (const name of context.authors) {
			authorList.createEl("option", { attr: { value: name } });
		}

		authorInput.placeholder = context.resolveDefaultAuthor() || "Author";
	};

	headerArea.addEventListener("pointerenter", () => void refreshHeaderFields());
	authorInput.addEventListener("focus", () => void refreshHeaderFields());

	const resetHeaderFields = () => {
		authorInput.value = "";
		timeInput.value = "";
		timeInput.classList.remove("is-invalid");
		// nothing left to hold the row open, so the dismissal has nothing left to suppress
		setHeaderAreaCollapsed(false);
		updateHeaderAreaState();
	};

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

		// empty string -> undefined, so appendMessage falls back to the configured default
		const messageId = await plugin.appendMessage(file, value, {
			author: authorInput.value.trim() || undefined,
			timestamp: timeInput.value.trim() || undefined
		});

		textarea.value = "";
		plugin.getChatNote(file).inputCache = "";
		resizeInput();

		// header overrides apply to the message they were typed for and nothing after it;
		// the next message re-derives both from the configured defaults
		resetHeaderFields();

		// a pending reply only applies to the message it was just sent with
		void plugin.handleCancelReply();

		// not awaited: the scroll waits on the render of a message already written to disk,
		// so nothing here depends on it and the input stays responsive meanwhile
		if (plugin.getConfigCache(file).scrollOnSend) {
			void plugin.scrollToBottomAfterSend(file, messageId).catch(err => {
				console.error("Failed to scroll after sending", err);
			});
		}
	};

	/* Keyboard route into the header overrides, mirroring what hovering the area does with
	   the mouse: Mod+Up from the textarea opens the row and puts the caret in Author,
	   Mod+Up (or Escape) from either field closes it and hands focus back to the textarea.
	   It pins rather than merely focusing, so the row stays open if the user then clicks
	   away - the same end state the "···" button produces. */
	const openHeaderArea = () => {
		setHeaderAreaPinned(true);
		// focusing the author field also refreshes the suggestions/placeholder (see above)
		authorInput.focus();
		authorInput.select();
	};

	const closeHeaderArea = () => {
		setHeaderAreaPinned(false);
		// same dismissal the "···" button performs, so the row really closes even with a
		// value typed - the keyboard route would otherwise be a no-op in exactly that case
		setHeaderAreaCollapsed(true);
		textarea.focus();
	};

	// Obsidian's global hotkey scope can swallow "Mod+Enter" before it ever
	// reaches a plain keydown listener (e.g. if some other command already
	// claims that combo). Registering our own scope and pushing it while
	// the input is focused makes our binding take priority instead.
	// Mod+Up needs this doubly: it is bound globally to "Scroll to Top", which it
	// keeps doing everywhere except while one of these fields holds focus.
	const sendScope = new Scope(plugin.app.scope);
	sendScope.register(["Mod"], "Enter", () => {
		void sendMessage();
		return false; // auto preventDefault, stops a newline from being inserted
	});
	sendScope.register(["Mod"], "ArrowUp", () => {
		openHeaderArea();
		return false;
	});
	textarea.addEventListener("focus", () => plugin.app.keymap.pushScope(sendScope));
	textarea.addEventListener("blur", () => plugin.app.keymap.popScope(sendScope));

	const headerScope = new Scope(plugin.app.scope);
	headerScope.register(["Mod"], "ArrowUp", () => {
		closeHeaderArea();
		return false;
	});
	headerScope.register([], "Escape", () => {
		closeHeaderArea();
		return false;
	});

	for (const field of [authorInput, timeInput]) {
		// blur always fires before the next element's focus, so moving between the two
		// fields pops and re-pushes in order rather than stacking the scope twice
		field.addEventListener("focus", () => {
			plugin.app.keymap.pushScope(headerScope);
			// deliberately back in the row, so an earlier dismissal no longer applies
			setHeaderAreaCollapsed(false);
		});
		field.addEventListener("blur", () => plugin.app.keymap.popScope(headerScope));
	}

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
