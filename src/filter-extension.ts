import { Extension, Prec, RangeSetBuilder, StateEffect, StateField, EditorState } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField, TFile } from "obsidian";
import { hiddenLineRanges, MessageFilter } from "./search";

/* Collapses the messages a filter hides (pinned-only, search) in Live Preview.

   The CSS rules alone hide a row only once it has rendered. CodeMirror renders just the lines
   near the viewport and reserves an ESTIMATED height for everything else, so between two
   matches far apart the hidden messages that never rendered still took up their estimated
   space - a blank gap, with the later match pushed below it until scrolling rendered and
   collapsed what was in between. A replacing block decoration tells CodeMirror the range has
   no height without rendering any of it. The row flags and CSS stay: Reading View relies on
   them, and they cover a block typed after the last refresh. */

// dispatched when a file's filter changes; the field recomputes on it
const refreshFilter = StateEffect.define<null>();

class CollapsedMessages extends WidgetType {
	toDOM(): HTMLElement {
		return createDiv("chat-filter-collapsed");
	}

	eq(): boolean {
		return true;
	}

	get estimatedHeight(): number {
		return 0;
	}
}

const collapsed = Decoration.replace({ block: true, widget: new CollapsedMessages() });

export function createFilterExtension(getFilter: (file: TFile) => MessageFilter | null): {
	extension: Extension;
	refresh: (file: TFile) => void;
} {

	const compute = (state: EditorState): DecorationSet => {
		// source mode shows the raw text, which nothing filters
		if (!state.field(editorLivePreviewField, false)) return Decoration.none;

		const file = state.field(editorInfoField, false)?.file;
		const filter = file ? getFilter(file) : null;
		if (!filter) return Decoration.none;

		const doc = state.doc;
		const builder = new RangeSetBuilder<Decoration>();
		for (const [start, end] of hiddenLineRanges(doc.toString(), filter)) {
			if (end + 1 > doc.lines) continue;
			builder.add(doc.line(start + 1).from, doc.line(end + 1).to, collapsed);
		}
		return builder.finish();
	};

	/* A StateField, because CodeMirror only takes block decorations from one. Highest
	   precedence, so it wins over Live Preview's own widget for the same code block. */
	const field = StateField.define<DecorationSet>({
		create: compute,
		update(value, tr) {
			const modeChanged = tr.startState.field(editorLivePreviewField, false)
				!== tr.state.field(editorLivePreviewField, false);

			if (modeChanged || tr.effects.some(e => e.is(refreshFilter))) return compute(tr.state);

			/* Mapped rather than recomputed, so typing in a filtered note doesn't reparse the
			   whole file per key. The plugin refreshes once the edit reaches the model. */
			return tr.docChanged ? value.map(tr.changes) : value;
		},
		provide: f => Prec.highest(EditorView.decorations.from(f))
	});

	// the editors currently open, so a filter change can reach the ones showing its file
	const views = new Set<EditorView>();
	const tracker = ViewPlugin.define(view => {
		views.add(view);
		return { destroy: () => { views.delete(view); } };
	});

	const refresh = (file: TFile) => {
		for (const view of views) {
			if (view.state.field(editorInfoField, false)?.file?.path !== file.path) continue;
			view.dispatch({ effects: refreshFilter.of(null) });
		}
	};

	return { extension: [field, tracker], refresh };
}
