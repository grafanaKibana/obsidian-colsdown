const { editorLivePreviewField, editorInfoField, MarkdownRenderChild } = require("obsidian");
const { scanMarkerLayouts } = require("./markers.cjs");
const { markerContext } = require("./marker-rendering.cjs");

function visibleMarkerLayouts(source, ranges) {
  return scanMarkerLayouts(source).filter((candidate) => candidate.depth === 0
    && !ranges.some((range) => range.from <= candidate.end && range.to >= candidate.start));
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
      const content = element.ownerDocument.createElement("div");
      const edit = element.ownerDocument.createElement("button");
      edit.className = "colsdown-marker-edit clickable-icon";
      edit.type = "button"; edit.textContent = "Edit";
      edit.setAttribute("aria-label", "Edit column source");
      element.append(edit, content);
      const owner = plugin.addChild(new MarkdownRenderChild(element));
      let disposed = false;
      element.colsdownDispose = () => {
        if (disposed) return;
        disposed = true;
        plugin.removeChild(owner);
      };
      owner.registerDomEvent(edit, "click", (event) => {
        event.preventDefault(); event.stopPropagation();
        view.dispatch({ selection: { anchor: this.candidate.start }, scrollIntoView: true });
        view.focus();
      });
      const context = markerContext({ sourcePath: this.path,
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
