
import { MarkdownView, App, TFile} from "obsidian";

export function getContentMetrics(view: MarkdownView) {
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

export function isChatFile(app: App, file: TFile): boolean {
	const cache = app.metadataCache.getFileCache(file);
	return cache?.frontmatter?.type === "chat";
}