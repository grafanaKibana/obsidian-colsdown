const { editorLivePreviewField, editorInfoField, MarkdownRenderChild, Notice } = require("obsidian");
const { scanEditorLayouts, markerContext, layoutItemRanges } = require("./marker-rendering.cjs");
const { parseLayoutSource } = require("./layout.cjs");

function visibleMarkerLayouts(source) {
  const regions = scanEditorLayouts(source);
  return regions.filter((candidate) => !regions.some((parent) => parent !== candidate
    && parent.start <= candidate.start && parent.end >= candidate.end));
}

function registerMarkerEditor(plugin, renderLayout) {
  if (!editorLivePreviewField || !editorInfoField || !plugin.registerEditorExtension) return;
  // Obsidian supplies these public editor runtimes; esbuild leaves them external.
  // eslint-disable-next-line import/no-extraneous-dependencies -- Supplied by Obsidian.
  const { StateField, EditorState, Transaction, Prec } = require("@codemirror/state");
  // eslint-disable-next-line import/no-extraneous-dependencies -- Supplied by Obsidian.
  const { Decoration, EditorView, WidgetType, keymap } = require("@codemirror/view");
  class InlineEditing {
    constructor(view, element, candidate, path, snapshot) {
      Object.assign(this, { view, element, candidate, path, snapshot });
      this.items = new Set(); this.layouts = new Set(); this.active = null; this.disposed = false; this.ready = false;
    }
    registerItem(item) {
      if (this.disposed || !Number.isInteger(item.from) || !Number.isInteger(item.to)
        || item.from < this.candidate.start || item.from > item.to || item.to > this.candidate.end) return () => {};
      this.items.add(item);
      item.element.dataset.colsdownInlineItem = "true";
      return () => {
        this.items.delete(item);
        delete item.element.dataset.colsdownInlineItem;
        if (this.active?.item === item) this.finish(false);
      };
    }
    registerLayout(registration) {
      const handle = registration.context.layoutHandle;
      if (this.disposed || handle?.snapshot !== this.snapshot || !scanEditorLayouts(this.snapshot).some((region) =>
        region.start === handle.start && region.syntax === handle.syntax && region.body === handle.source)) {
        registration.context.inlineEditing = null;
        return () => {};
      }
      this.layouts.add(registration);
      return () => this.layouts.delete(registration);
    }
    structure(candidate) {
      const parsed = parseLayoutSource(candidate.body, candidate.direction, plugin.settings?.separator, candidate.syntax);
      const ranges = layoutItemRanges(candidate.body, parsed, candidate.syntax);
      let cursor = 0;
      const structure = ranges.map((range) => {
        const boundary = candidate.body.slice(cursor, range.from); cursor = range.to; return boundary;
      });
      return structure.join("\0") + candidate.body.slice(cursor);
    }
    current() {
      return !this.disposed && !this.view.state.facet(EditorState.readOnly)
        && this.view.state.field(editorInfoField, false)?.file?.path === this.path
        && this.view.state.doc.toString() === this.snapshot;
    }
    sync(widget) {
      if (this.disposed || this.path !== widget.path) return false;
      const transaction = widget.transaction;
      const changed = this.snapshot !== widget.snapshot;
      if (changed && !this.ready) return false;
      if (changed && (!transaction || transaction.startState.doc.toString() !== this.snapshot)) return false;
      const changes = transaction?.changes;
      if (changed && (changes.mapPos(this.candidate.start, 1) !== widget.candidate.start
        || changes.mapPos(this.candidate.end, -1) !== widget.candidate.end)) return false;
      if (changed) {
        const regions = scanEditorLayouts(widget.snapshot);
        const previousRegions = scanEditorLayouts(this.snapshot).filter((region) => region.start >= this.candidate.start && region.end <= this.candidate.end);
        const nextRegions = regions.filter((region) => region.start >= widget.candidate.start && region.end <= widget.candidate.end);
        if (previousRegions.length !== nextRegions.length || previousRegions.some((region, index) =>
          region.syntax !== nextRegions[index].syntax || this.structure(region) !== this.structure(nextRegions[index]))) return false;
        for (const { context, onUpdate } of this.layouts) {
          const handle = context.layoutHandle;
          if (!handle || !Number.isInteger(handle.start)) continue;
          const start = changes.mapPos(handle.start, 1);
          const next = regions.find((region) => region.start === start && region.syntax === handle.syntax);
          if (!next) return false;
          onUpdate?.(this.snapshot, widget.snapshot, next);
          Object.assign(handle, { start: next.start, bodyStart: next.bodyStart, source: next.body,
            snapshot: widget.snapshot, location: { lineStart: next.lineStart, lineEnd: next.lineEnd } });
        }
        for (const item of this.items) {
          const previous = this.snapshot.slice(item.from, item.to);
          item.from = changes.mapPos(item.from, -1);
          item.to = changes.mapPos(item.to, 1);
          const markdown = widget.snapshot.slice(item.from, item.to);
          if (!item.element.contains(this.active?.host ?? null) && markdown !== previous) {
            void Promise.resolve(item.renderPreview(markdown, item.from))
              .catch((error) => console.error("Colsdown failed to refresh a column preview.", error));
          }
        }
      }
      this.candidate = widget.candidate; this.snapshot = widget.snapshot;
      if (this.active) {
        const active = this.active;
        const text = widget.snapshot.slice(active.item.from, active.item.to);
        if (active.editor.state.sliceDoc() !== text) {
          this.syncing = true;
          try { active.editor.dispatch({ changes: { from: 0, to: active.editor.state.doc.length, insert: text } }); }
          finally { this.syncing = false; }
        }
      }
      return true;
    }
    rejectEdit(child, item) {
      const text = this.view.state.doc.sliceString(item.from, item.to);
      this.syncing = true;
      try { child.dispatch({ changes: { from: 0, to: child.state.doc.length, insert: text } }); }
      finally { this.syncing = false; }
      if (typeof Notice === "function") new Notice("The column edit could not be applied. The note was preserved.");
    }
    finish(render = true) {
      const active = this.active;
      if (!active) return;
      this.active = null;
      active.stopFocusWatch?.();
      active.editor.destroy(); active.host.remove();
      for (const [node, hidden] of active.hidden) node.hidden = hidden;
      if (render && this.current() && this.items.has(active.item)) {
        void Promise.resolve(active.item.renderPreview(this.snapshot.slice(active.item.from, active.item.to), active.item.from))
          .then(() => { if (!this.disposed) this.view.requestMeasure(); })
          .catch((error) => console.error("Colsdown failed to refresh a column preview.", error));
      }
    }
    open(item, coordinates) {
      if (!this.ready || !this.current() || !this.items.has(item)) return;
      if (this.active?.item === item) { this.active.editor.focus(); return; }
      this.finish();
      const host = item.element.ownerDocument.createElement("div");
      host.className = "colsdown-inline-editor";
      const hidden = [...item.element.children].map((node) => [node, node.hidden]);
      for (const [node] of hidden) node.hidden = true;
      item.element.append(host);
      const history = (redo) => {
        if (!this.current()) return true;
        const editor = this.view.state.field(editorInfoField, false)?.editor;
        if (redo) editor?.redo(); else editor?.undo();
        return true;
      };
      const finishWhenUnfocused = () => {
        queueMicrotask(() => {
          if (this.active?.host === host && !this.active.editor.composing
            && !host.contains(host.ownerDocument.activeElement)) this.finish();
        });
      };
      const state = EditorState.create({
        doc: this.snapshot.slice(item.from, item.to),
        extensions: [EditorState.lineSeparator.of(this.snapshot.includes("\r\n") ? "\r\n" : this.snapshot.includes("\r") ? "\r" : "\n"), EditorView.lineWrapping, EditorView.contentAttributes.of({ "aria-label": "Edit column Markdown" }),
          keymap.of([
            { key: "Mod-z", run: () => history(false) },
            { key: "Mod-Shift-z", run: () => history(true) },
            { key: "Mod-y", run: () => history(true) },
            { key: "Enter", run: (editor) => { editor.dispatch(editor.state.replaceSelection("\n"), { userEvent: "input" }); return true; } },
            { key: "Tab", run: (editor) => { editor.dispatch(editor.state.replaceSelection("\t"), { userEvent: "input" }); return true; } },
            { key: "Escape", run: () => {
              this.finish();
              this.view.dispatch({ selection: { anchor: this.candidate.end } });
              this.view.focus(); return true;
            } },
          ]),
          EditorView.domEventHandlers({ blur: finishWhenUnfocused }),
        ],
      });
      const editor = new EditorView({ state, parent: host, dispatchTransactions: (transactions, child) => {
        if (!this.syncing && transactions.some((transaction) => transaction.docChanged)
          && (!this.current() || this.snapshot.slice(item.from, item.to) !== transactions[0].startState.sliceDoc())) {
          this.rejectEdit(child, item); return;
        }
        child.update(transactions);
        if (this.syncing) return;
        for (const transaction of transactions) {
          if (!transaction.docChanged || !this.active || !this.current()) continue;
          const before = transaction.startState.sliceDoc();
          if (this.snapshot.slice(item.from, item.to) !== before) continue;
          const edits = [];
          transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
            edits.push({ from: item.from + transaction.startState.sliceDoc(0, from).length,
              to: item.from + transaction.startState.sliceDoc(0, to).length,
              insert: inserted.sliceString(0, inserted.length, transaction.state.lineBreak) });
          });
          const event = transaction.annotation(Transaction.userEvent);
          this.view.dispatch({ changes: edits,
            selection: { anchor: item.from + transaction.state.sliceDoc(0, transaction.state.selection.main.anchor).length,
              head: item.from + transaction.state.sliceDoc(0, transaction.state.selection.main.head).length },
            ...(event ? { annotations: Transaction.userEvent.of(event) } : {}),
          });
          if (this.active?.editor === child && this.view.state.doc.sliceString(item.from, item.to) !== child.state.sliceDoc()) {
            this.rejectEdit(child, item); break;
          }
        }
      } });
      host.ownerDocument.addEventListener("focusin", finishWhenUnfocused, true);
      this.active = { item, host, hidden, editor,
        stopFocusWatch: () => host.ownerDocument.removeEventListener("focusin", finishWhenUnfocused, true) };
      host.addEventListener("focusout", finishWhenUnfocused);
      for (const type of ["mousedown", "keydown", "keyup", "click"]) host.addEventListener(type, (event) => event.stopPropagation());
      host.addEventListener("compositionend", () => {
        host.ownerDocument.defaultView.setTimeout(() => {
          if (this.active?.host === host && !host.contains(host.ownerDocument.activeElement)) this.finish();
        }, 0);
      });
      editor.focus();
      if (coordinates?.x > 0 && coordinates?.y > 0) {
        const position = editor.posAtCoords(coordinates);
        if (position !== null) editor.dispatch({ selection: { anchor: Math.max(0, Math.min(position, editor.state.doc.length)) } });
      }
      this.view.requestMeasure();
    }
    dispose() { this.disposed = true; this.finish(false); this.items.clear(); this.layouts.clear(); }
  }
  class MarkerWidget extends WidgetType {
    constructor(candidate, path, snapshot, transaction) {
      super(); Object.assign(this, { candidate, path, snapshot, transaction });
    }
    eq(other) {
      return this.path === other.path && this.snapshot === other.snapshot
        && this.candidate.start === other.candidate.start && this.candidate.body === other.candidate.body;
    }
    updateDOM(element) { return element.colsdownInlineEditing?.sync(this) ?? false; }
    toDOM(view) {
      const element = view.dom.ownerDocument.createElement("div");
      element.className = "colsdown-marker-widget";
      element.tabIndex = 0;
      element.setAttribute("role", "group");
      element.setAttribute("aria-label", "Column layout");
      const content = element.ownerDocument.createElement("div"); element.append(content);
      const owner = plugin.addChild(new MarkdownRenderChild(element));
      const editing = new InlineEditing(view, element, this.candidate, this.path, this.snapshot);
      element.colsdownInlineEditing = editing;
      element.colsdownDispose = () => {
        if (editing.disposed) return;
        editing.dispose(); plugin.removeChild(owner);
      };
      owner.registerDomEvent(element, "click", (event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
          || element.ownerDocument.getSelection()?.isCollapsed === false) return;
        const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
        if (!target) return;
        const interactive = target.closest("a, button, input, textarea, select, summary, [role=button], [role=link], [role=checkbox], [contenteditable=true], .cm-editor, .internal-embed, .colsdown-inline-editor, .colsdown-resize-handle, .colsdown-add-column");
        if (interactive && element.contains(interactive)) return;
        const itemElement = target.closest("[data-colsdown-inline-item]");
        if (target.closest(".layout-item") !== itemElement) return;
        const item = [...editing.items].find((entry) => entry.element === itemElement);
        if (!item) return;
        event.preventDefault(); event.stopPropagation(); editing.open(item, { x: event.clientX, y: event.clientY });
      });
      owner.registerDomEvent(element, "keydown", (event) => {
        if (event.target !== element || event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        const item = [...editing.items].sort((left, right) => left.from - right.from)[0];
        if (!item) return;
        event.preventDefault(); event.stopPropagation(); editing.open(item);
      });
      const context = markerContext({ sourcePath: this.path, inlineEditing: editing,
        addChild: (child) => owner.addChild(child),
        getSectionInfo: () => ({ text: view.state.doc.toString(),
          lineStart: editing.candidate.lineStart, lineEnd: editing.candidate.lineEnd }),
      }, this.candidate, this.snapshot);
      context.layoutHandle.getSnapshot = () => view.state.doc.toString();
      void renderLayout(plugin, this.candidate.body, content, context, this.candidate.direction)
        .then(() => { if (!editing.disposed) { editing.ready = true; view.requestMeasure(); } })
        .catch((error) => {
          if (!editing.disposed) { content.textContent = editing.candidate.body; view.requestMeasure(); }
          console.error("Colsdown failed to render column preview.", error);
        });
      return element;
    }
    destroy(element) { element.colsdownDispose?.(); }
    ignoreEvent() { return true; }
  }
  const decorations = (state, transaction) => {
    if (!state.field(editorLivePreviewField, false)) return Decoration.none;
    const info = state.field(editorInfoField, false);
    if (!info?.file?.path) return Decoration.none;
    const snapshot = state.doc.toString();
    return Decoration.set(visibleMarkerLayouts(snapshot).map((candidate) => (
      Decoration.replace({ block: true, widget: new MarkerWidget(candidate, info.file.path, snapshot, transaction) })
        .range(candidate.start, candidate.end)
    )));
  };
  plugin.registerEditorExtension(Prec.highest(StateField.define({
    create: decorations,
    update: (_value, transaction) => decorations(transaction.state, transaction),
    provide: (field) => EditorView.decorations.from(field),
  })));
}
module.exports = { visibleMarkerLayouts, registerMarkerEditor };
