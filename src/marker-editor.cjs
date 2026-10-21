const { editorLivePreviewField, editorInfoField, MarkdownRenderChild, Notice, Scope } = require("obsidian");
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
  const { StateField, StateEffect, EditorState, EditorSelection, Transaction, Prec } = require("@codemirror/state");
  // eslint-disable-next-line import/no-extraneous-dependencies -- Supplied by Obsidian.
  const { Decoration, Direction, EditorView, WidgetType, keymap } = require("@codemirror/view");
  const arrowDirections = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
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
        if (this.active) {
          this.active.range.from = changes.mapPos(this.active.range.from, -1);
          this.active.range.to = changes.mapPos(this.active.range.to, 1);
        }
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
        const text = widget.snapshot.slice(active.range.from, active.range.to);
        this.syncChild(active.editor, text);
      }
      return true;
    }
    syncChild(child, text) {
      const target = child.state.toText(text);
      const before = child.state.doc.toString();
      const after = target.toString();
      if (before === after) return;
      let from = 0;
      while (from < before.length && from < after.length && before[from] === after[from]) from += 1;
      let to = before.length;
      let end = after.length;
      while (to > from && end > from && before[to - 1] === after[end - 1]) { to -= 1; end -= 1; }
      this.syncing = true;
      try { child.dispatch({ changes: { from, to, insert: target.slice(from, end) } }); }
      finally { this.syncing = false; }
    }
    rejectEdit(child, item) {
      this.syncChild(child, this.view.state.doc.sliceString(item.from, item.to));
      if (typeof Notice === "function") new Notice("The column edit could not be applied. The note was preserved.");
    }
    finish(render = true) {
      const active = this.active;
      if (!active) return;
      this.active = null;
      active.stopFocusWatch?.();
      active.stopKeyScope?.();
      active.editor.destroy(); active.host.remove();
      for (const [node, hidden] of active.hidden) node.hidden = hidden;
      if (render && this.current() && this.items.has(active.item)) {
        void Promise.resolve(active.item.renderPreview(this.snapshot.slice(active.item.from, active.item.to), active.item.from))
          .then(() => { if (!this.disposed) this.view.requestMeasure(); })
          .catch((error) => console.error("Colsdown failed to refresh a column preview.", error))
          .finally(active.releaseGeometry);
      } else active.releaseGeometry();
    }
    navigate(child, direction, extend = false) {
      if (this.active?.editor !== child || child.composing) return false;
      if (!this.current()) return true;
      const selection = child.state.selection.main;
      const vertical = direction === "up" || direction === "down";
      const forward = vertical ? direction === "down"
        : (direction === "right") === (child.textDirectionAt(selection.head) !== Direction.RTL);
      if (!extend && !selection.empty) {
        child.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(forward ? selection.to : selection.from)]), scrollIntoView: true });
        return true;
      }
      const edge = forward ? child.state.doc.length : 0;
      const here = vertical ? child.coordsAtPos(selection.head, selection.assoc < 0 ? -1 : 1) : null;
      const edgeRect = vertical ? child.coordsAtPos(edge, forward ? -1 : 1) : null;
      const boundary = vertical && here && edgeRect ? Math.abs(here.top - edgeRect.top) < 1 : selection.head === edge;
      if (boundary && !extend) {
        const goalX = Number.isFinite(selection.goalColumn) ? child.contentDOM.getBoundingClientRect().left + selection.goalColumn : here?.left;
        const relativeX = Number.isFinite(goalX) ? goalX - this.active.item.element.getBoundingClientRect().left : undefined;
        this.crossColumn(this.active.item, forward, relativeX);
        return true;
      }
      const next = boundary ? EditorSelection.cursor(edge, forward ? 1 : -1, selection.bidiLevel ?? undefined, selection.goalColumn)
        : vertical ? child.moveVertically(selection, forward) : child.moveByChar(selection, forward);
      const range = extend ? EditorSelection.range(selection.anchor, next.head, next.goalColumn, next.bidiLevel ?? undefined) : next;
      child.dispatch({ selection: EditorSelection.create([range]), scrollIntoView: true, userEvent: "select.keyboard" });
      return true;
    }
    crossColumn(item, forward, relativeX) {
      const siblings = [...this.items].filter((candidate) => candidate.element.parentElement === item.element.parentElement)
        .sort((left, right) => left.from - right.from);
      const adjacent = siblings[siblings.indexOf(item) + (forward ? 1 : -1)];
      const enter = (target, position) => this.open(target, undefined, { atEnd: !forward, position,
        x: Number.isFinite(relativeX) ? target.element.getBoundingClientRect().left + relativeX : undefined });
      if (adjacent) { enter(adjacent); return; }
      const parent = [...this.items].filter((candidate) => candidate !== item && candidate.element.contains(item.element))
        .sort((left, right) => (left.to - left.from) - (right.to - right.from))[0];
      if (parent) {
        const nested = scanEditorLayouts(this.snapshot).filter((candidate) => candidate.start >= parent.from
          && candidate.start <= item.from && candidate.end >= item.to)
          .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
        if (nested) {
          const remaining = forward ? this.snapshot.slice(nested.end, parent.to) : this.snapshot.slice(parent.from, nested.start);
          if (remaining.trim()) {
            const blank = forward ? /^(?:[ \t]*(?:\r\n|\r|\n))*/.exec(remaining)[0].length
              : /(?:(?:\r\n|\r|\n)[ \t]*)*$/.exec(remaining)[0].length;
            enter(parent, forward ? nested.end + blank : nested.start - blank);
            return;
          }
        }
        this.crossColumn(parent, forward, relativeX);
        return;
      }
      let position = forward ? this.candidate.end : this.candidate.start > 0 ? this.view.state.doc.lineAt(this.candidate.start - 1).to : 0;
      const other = visibleMarkerLayouts(this.snapshot).find((candidate) => candidate.start !== this.candidate.start
        && position >= candidate.start && position < candidate.end);
      if (other) position = forward ? other.start : other.end;
      this.finish();
      this.view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(position, forward ? 1 : -1)]), scrollIntoView: true, userEvent: "select.keyboard" });
      this.view.focus();
    }
    open(item, coordinates, entry) {
      if (!this.ready || !this.current() || !this.items.has(item)) return;
      if (this.active?.item === item) { this.active.editor.focus(); return; }
      this.finish();
      const original = this.snapshot.slice(item.from, item.to);
      const leading = /^(?:[ \t]*(?:\r\n|\r|\n))*/.exec(original)[0].length;
      const trailing = /(?:(?:\r\n|\r|\n)[ \t]*)*$/.exec(original.slice(leading))[0].length;
      const range = { from: item.from + leading, to: item.to - trailing };
      const bounds = item.element.getBoundingClientRect();
      const document = item.element.ownerDocument;
      const walker = document.createTreeWalker(item.element, 4);
      const textAnchors = [];
      let firstTextTop = null;
      let sourceCursor = leading;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim() || node.parentElement.closest("[hidden], [aria-hidden=true], button, .colsdown-inline-editor")) continue;
        const textRange = document.createRange(); textRange.selectNodeContents(node);
        const rect = [...(textRange.getClientRects?.() ?? [])].find((rect) => rect.height > 0 && rect.width > 0);
        if (rect) {
          firstTextTop ??= rect.top;
          const offset = original.indexOf(node.textContent, sourceCursor);
          if (offset < 0 || offset >= original.length - trailing) continue;
          textAnchors.push({ offset: offset - leading, top: rect.top });
          sourceCursor = offset + node.textContent.length;
        }
      }
      if (!textAnchors.length && firstTextTop !== null) textAnchors.push({ offset: 0, top: firstTextTop });
      const previousMinimum = item.geometryReservation?.previousMinimum ?? {
        value: item.element.style.getPropertyValue("min-height"), priority: item.element.style.getPropertyPriority("min-height"),
      };
      const reservation = { previousMinimum };
      item.geometryReservation = reservation;
      item.element.style.setProperty("min-height", `${bounds.height}px`);
      const releaseGeometry = () => {
        if (item.geometryReservation !== reservation) return;
        delete item.geometryReservation;
        if (previousMinimum.value) item.element.style.setProperty("min-height", previousMinimum.value, previousMinimum.priority);
        else item.element.style.removeProperty("min-height");
      };
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
      const selectAll = (child) => {
        child.dispatch({ selection: { anchor: 0, head: child.state.doc.length } });
        return true;
      };
      const finishWhenUnfocused = () => {
        queueMicrotask(() => {
          if (this.active?.host === host && !this.active.editor.composing
            && !host.contains(host.ownerDocument.activeElement)) this.finish();
        });
      };
      const setSpacing = StateEffect.define();
      const spacing = StateField.define({
        create: () => Decoration.none,
        update: (value, transaction) => {
          const replacement = transaction.effects.find((effect) => effect.is(setSpacing));
          return replacement ? replacement.value : value.map(transaction.changes);
        },
        provide: (field) => EditorView.decorations.from(field),
      });
      const state = EditorState.create({
        doc: this.snapshot.slice(range.from, range.to),
        extensions: [spacing, EditorState.lineSeparator.of(this.snapshot.includes("\r\n") ? "\r\n" : this.snapshot.includes("\r") ? "\r" : "\n"), EditorView.lineWrapping, EditorView.contentAttributes.of({ "aria-label": "Edit column Markdown" }),
          keymap.of([
            { key: "Mod-a", run: selectAll },
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
          EditorView.domEventHandlers({ blur: finishWhenUnfocused, keydown: (event, child) => {
            const direction = arrowDirections[event.key];
            if (!direction || event.metaKey || event.ctrlKey || event.altKey || event.isComposing || event.keyCode === 229) return false;
            return this.navigate(child, direction, event.shiftKey);
          } }),
        ],
      });
      const editor = new EditorView({ state, parent: host, dispatchTransactions: (transactions, child) => {
        if (!this.syncing && transactions.some((transaction) => transaction.docChanged)
          && (!this.current() || this.snapshot.slice(range.from, range.to) !== transactions[0].startState.sliceDoc())) {
          this.rejectEdit(child, range); return;
        }
        child.update(transactions);
        if (this.syncing) return;
        for (const transaction of transactions) {
          if (!transaction.docChanged || !this.active || !this.current()) continue;
          const before = transaction.startState.sliceDoc();
          if (this.snapshot.slice(range.from, range.to) !== before) continue;
          const edits = [];
          transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
            edits.push({ from: range.from + transaction.startState.sliceDoc(0, from).length,
              to: range.from + transaction.startState.sliceDoc(0, to).length,
              insert: inserted.sliceString(0, inserted.length, transaction.state.lineBreak) });
          });
          const event = transaction.annotation(Transaction.userEvent);
          this.view.dispatch({ changes: edits,
            selection: { anchor: range.from + transaction.state.sliceDoc(0, transaction.state.selection.main.anchor).length,
              head: range.from + transaction.state.sliceDoc(0, transaction.state.selection.main.head).length },
            ...(event ? { annotations: Transaction.userEvent.of(event) } : {}),
          });
          if (this.active?.editor === child && this.view.state.doc.sliceString(range.from, range.to) !== child.state.sliceDoc()) {
            this.rejectEdit(child, range); break;
          }
        }
      } });
      host.ownerDocument.addEventListener("focusin", finishWhenUnfocused, true);
      this.active = { item, range, host, hidden, editor, releaseGeometry,
        stopFocusWatch: () => host.ownerDocument.removeEventListener("focusin", finishWhenUnfocused, true) };
      host.addEventListener("focusout", finishWhenUnfocused);
      for (const type of ["mousedown", "keydown", "keyup", "click"]) host.addEventListener(type, (event) => event.stopPropagation());
      host.addEventListener("compositionend", () => {
        host.ownerDocument.defaultView.setTimeout(() => {
          if (this.active?.host === host && !host.contains(host.ownerDocument.activeElement)) this.finish();
        }, 0);
      });
      // Source matching here affects presentation only; writes use the exact range above.
      const lineSpacing = [];
      let insertedSpace = 0;
      let previousLine = -1;
      for (const anchor of textAnchors) {
        const position = this.snapshot.slice(range.from, range.from + anchor.offset).replace(/\r\n|\r/g, "\n").length;
        const line = editor.state.doc.lineAt(Math.min(position, editor.state.doc.length));
        if (line.from === previousLine) continue;
        const editorText = editor.coordsAtPos(line.from);
        if (!editorText) continue;
        const padding = Math.max(0, anchor.top - editorText.top - insertedSpace);
        if (padding > 0) {
          lineSpacing.push(Decoration.line({ attributes: { style: `padding-top: ${padding}px` } }).range(line.from));
          insertedSpace += padding;
        }
        previousLine = line.from;
      }
      if (lineSpacing.length) editor.dispatch({ effects: setSpacing.of(Decoration.set(lineSpacing)) });
      editor.focus();
      if (typeof Scope === "function" && plugin.app?.keymap?.pushScope && plugin.app.keymap.popScope) {
        const scope = new Scope(plugin.app.scope);
        scope.register(["Mod"], "a", (event) => {
          if (this.active?.editor !== editor || !host.contains(event.target)) return;
          selectAll(editor);
          return false;
        });
        for (const [key, direction] of Object.entries(arrowDirections)) {
          for (const extend of [false, true]) scope.register(extend ? ["Shift"] : [], key, (event) => {
            if (event.isComposing || event.keyCode === 229 || !host.contains(event.target)) return;
            if (this.navigate(editor, direction, extend)) { event.stopPropagation(); return false; }
          });
        }
        plugin.app.keymap.pushScope(scope);
        this.active.stopKeyScope = () => plugin.app.keymap.popScope(scope);
      }
      if (entry) {
        let anchor = Number.isInteger(entry.position)
          ? editor.state.toText(this.snapshot.slice(range.from, Math.max(range.from, Math.min(entry.position, range.to)))).length
          : entry.atEnd ? editor.state.doc.length : 0;
        if (Number.isFinite(entry.x)) {
          const rect = editor.coordsAtPos(anchor);
          if (rect) anchor = editor.posAtCoords({ x: entry.x, y: (rect.top + rect.bottom) / 2 }) ?? anchor;
        }
        const goal = Number.isFinite(entry.x) ? entry.x - editor.contentDOM.getBoundingClientRect().left : undefined;
        editor.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(anchor, entry.atEnd ? -1 : 1, undefined, goal)]), scrollIntoView: true });
      }
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
  const enterLayout = (view, direction) => {
    const selection = view.state.selection.main;
    if (view.composing || !view.state.field(editorLivePreviewField, false) || view.state.selection.ranges.length !== 1 || !selection.empty
      || view.dom.ownerDocument.activeElement !== view.contentDOM) return false;
    const vertical = direction === "up" || direction === "down";
    const forward = vertical ? direction === "down"
      : (direction === "right") === (view.textDirectionAt(selection.head) !== Direction.RTL);
    const widgets = [...view.dom.querySelectorAll(".colsdown-marker-widget")];
    const controllers = widgets.map((element) => element.colsdownInlineEditing).filter((editing) => editing?.ready && editing.current());
    if (!controllers.length) return false;
    const next = vertical ? view.moveVertically(selection, forward) : view.moveByChar(selection, forward);
    const editing = controllers.sort((left, right) => forward ? left.candidate.start - right.candidate.start : right.candidate.end - left.candidate.end)
      .find(({ candidate }) => forward
        ? selection.head < candidate.end && next.head >= candidate.start && next.head >= selection.head
        : selection.head > candidate.start && next.head <= candidate.end && next.head <= selection.head);
    if (!editing) return false;
    const items = [...editing.items].filter((item, _index, all) => !all.some((parent) => parent !== item && parent.element.contains(item.element)))
      .sort((left, right) => forward ? left.from - right.from : right.from - left.from);
    const item = items[0];
    if (!item) return false;
    const caret = vertical ? view.coordsAtPos(selection.head) : null;
    const x = caret ? item.element.getBoundingClientRect().left + caret.left - editing.element.getBoundingClientRect().left : undefined;
    editing.open(item, undefined, { atEnd: !forward, x });
    return editing.active?.item === item;
  };
  plugin.registerEditorExtension(Prec.highest([StateField.define({
    create: decorations,
    update: (_value, transaction) => decorations(transaction.state, transaction),
    provide: (field) => EditorView.decorations.from(field),
  }), keymap.of([
    { key: "ArrowDown", run: (view) => enterLayout(view, "down") },
    { key: "ArrowUp", run: (view) => enterLayout(view, "up") },
    { key: "ArrowRight", run: (view) => enterLayout(view, "right") },
    { key: "ArrowLeft", run: (view) => enterLayout(view, "left") },
  ])]));
}
module.exports = { visibleMarkerLayouts, registerMarkerEditor };
