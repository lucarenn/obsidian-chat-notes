import { MarkdownView, App, TFile} from "obsidian";


export function isChatFile(app: App, file: TFile): boolean {
	const cache = app.metadataCache.getFileCache(file);
	return cache?.frontmatter?.type === "chat";
}

export function scrollDocument(view: MarkdownView, position: "top" | "bottom") {
	const preview = view.containerEl.querySelector(".markdown-preview-view");
	const cmScroller = view.containerEl.querySelector(".cm-scroller");

	const targetTop = position === "top" ? 0 : Number.MAX_SAFE_INTEGER;

	if (cmScroller) {
		cmScroller.scrollTo({ top: targetTop });
	}

	if (preview) {
		preview.scrollTop = position === "top" ? 0 : preview.scrollHeight;
	}
}