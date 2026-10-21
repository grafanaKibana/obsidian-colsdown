const { editorLivePreviewField, editorInfoField, MarkdownRenderChild } = require("obsidian");
const { scanMarkerLayouts } = require("./markers.cjs");
const { markerContext } = require("./marker-rendering.cjs");

function visibleMarkerLayouts(source, ranges) {
  return scanMarkerLayouts(source).filter((candidate) => candidate.depth === 0
    && !ranges.some((range) => range.from === range.to
      ? range.from >= candidate.start && range.from < candidate.end
      : range.from < candidate.end && range.to > candidate.start));
}

function registerMarkerEditor(plugin, renderLayout) {
  if (!editorLivePreviewField || !editorInfoField || !plugin.registerEditorExtension) return;
  // These public editor runtimes are supplied by Obsidian and externalized by esbuild.
  // eslint-disable-next-line import/no-extraneous-dependencies -- Obsidian supplies this external editor runtime.
  const { StateField } = require("@codemirror/state");
  // eslint-disable-next-line import/no-extraneous-dependencies -- Obsidian supplies this external editor runtime.
  const { Decoration, EditorView, WidgetType } = require("@codemirror/view");
  class MarkerWidget extends WidgetType {
    constructor(candidate, path, snapshot) {
      super(); this.candidate = candidate; this.path = path; this.snapshot = snapshot;
    }
    eq(other) {
      return this.path === other.path && this.snapshot === other.snapshot
        && this.candidate.start === other.candidate.start && this.candidate.body === other.candidate.body;
    }
    toDOM(view) {
      const element = view.dom.ownerDocument.createElement("div");
      element.className = "colsdown-marker-widget";
      element.tabIndex = 0;
      element.setAttribute("role", "group");
      element.setAttribute("aria-label", "Column layout. Press enter to edit source.");
      const content = element.ownerDocument.createElement("div");
      element.append(content);
      const owner = plugin.addChild(new MarkdownRenderChild(element));
      let disposed = false;
      element.colsdownDispose = () => {
        if (disposed) return;
        disposed = true;
        plugin.removeChild(owner);
      };
      const editSource = (position) => {
        if (disposed || view.state.doc.toString() !== this.snapshot
          || !Number.isInteger(position) || position < this.candidate.start || position >= this.candidate.end) return;
        view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
        view.focus();
      };
      owner.registerDomEvent(element, "click", (event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
          || element.ownerDocument.getSelection()?.isCollapsed === false) return;
        const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
        if (!target) return;
        const interactive = target.closest("a, button, input, textarea, select, summary, [role=button], [role=link], [role=checkbox], [contenteditable=true], .internal-embed, .cm-editor, .colsdown-resize-handle, .colsdown-add-column");
        if (interactive && element.contains(interactive)) return;
        const item = target.closest("[data-colsdown-source-offset]");
        if (!item || !element.contains(item)) return;
        event.preventDefault(); event.stopPropagation();
        editSource(Number(item.dataset.colsdownSourceOffset));
      });
      owner.registerDomEvent(element, "keydown", (event) => {
        if (event.target !== element || event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        event.preventDefault(); event.stopPropagation();
        editSource(this.candidate.markers[0].bodyStart);
      });
      const context = markerContext({ sourcePath: this.path,
        editSource,
        addChild: (child) => owner.addChild(child),
        getSectionInfo: () => ({ text: view.state.doc.toString(),
          lineStart: this.candidate.lineStart, lineEnd: this.candidate.lineEnd }),
      }, this.candidate, this.snapshot);
      context.layoutHandle.getSnapshot = () => view.state.doc.toString();
      void renderLayout(plugin, this.candidate.body, content, context, this.candidate.direction)
        .then(() => { if (!disposed) view.requestMeasure(); })
        .catch((error) => {
          if (!disposed) { content.textContent = this.candidate.body; view.requestMeasure(); }
          console.error("Colsdown failed to render marker preview.", error);
        });
      return element;
    }
    destroy(element) { element.colsdownDispose?.(); }
    ignoreEvent() { return true; }
  }
  const decorations = (state) => {
    if (!state.field(editorLivePreviewField, false)) return Decoration.none;
    const info = state.field(editorInfoField, false);
    if (!info?.file?.path) return Decoration.none;
    const snapshot = state.doc.toString();
    return Decoration.set(visibleMarkerLayouts(snapshot, state.selection.ranges).map((candidate) => (
      Decoration.replace({ block: true, widget: new MarkerWidget(candidate, info.file.path, snapshot) })
        .range(candidate.start, candidate.end)
    )));
  };
  plugin.registerEditorExtension(StateField.define({
    create: decorations,
    update: (_value, transaction) => decorations(transaction.state),
    provide: (field) => EditorView.decorations.from(field),
  }));
}
module.exports = { visibleMarkerLayouts, registerMarkerEditor };
