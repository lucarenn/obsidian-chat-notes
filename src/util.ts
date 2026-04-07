import { MarkdownView, App, TFile} from "obsidian";


export function isChatFile(app: App, file: TFile): boolean {
	const cache = app.metadataCache.getFileCache(file);
	return cache?.frontmatter?.type === "chat";
}

export function scrollToBottom(view: MarkdownView) {
    const container = view.containerEl.querySelector(".markdown-preview-view");
    if (!container) return;

    const cmScroller = view.containerEl.querySelector(".cm-scroller");
    cmScroller?.scrollTo({ top: cmScroller.scrollHeight });
    
    container.scrollTop = container.scrollHeight;
}