const { MarkdownRenderChild, MarkdownRenderer } = require("obsidian");
const { scanMarkerLayouts } = require("./markers.cjs");
const { collectFootnoteDefinitions, hydrateFootnotes } = require("./footnotes.cjs");

function layoutItemOffsets(source, parsed, syntax) {
  if (syntax === "markers") return parsed.items.map((_item, index) => parsed.markers[index]?.bodyStart ?? -1);
  let cursor = 0;
  return parsed.items.map((item) => {
    const offset = source.indexOf(item.markdown, cursor);
    if (offset >= 0) cursor = offset + item.markdown.length;
    return offset;
  });
}

function markerContext(context, candidate, snapshot) {
  return {
    ...context,
    layoutHandle: {
      getSnapshot: context.layoutHandle?.getSnapshot,
      syntax: "markers", direction: candidate.direction, source: candidate.body,
      location: { lineStart: candidate.lineStart, lineEnd: candidate.lineEnd }, snapshot,
    },
  };
}

// Render nested marker regions from their authoritative Markdown, rather than
// asking a postprocessor to map a synthetic MarkdownRenderer section to a note.
async function renderMarkerMarkdown(plugin, markdown, element, context, owner, renderLayout) {
  let disposed = false;
  owner.register(() => { disposed = true; });
  const candidates = scanMarkerLayouts(markdown).filter((candidate) => candidate.depth === 0);
  if (!candidates.length) {
    await MarkdownRenderer.render(plugin.app, markdown, element, context.sourcePath, owner);
    return;
  }
  const definitions = collectFootnoteDefinitions(markdown);
  const renderSegment = (segment, target) => MarkdownRenderer.render(
    plugin.app, hydrateFootnotes(segment, definitions), target, context.sourcePath, owner,
  );
  let cursor = 0;
  const section = context.renderSectionInfo ?? context.getSectionInfo?.(element);
  const snapshot = context.layoutHandle?.snapshot ?? section?.text;
  for (const candidate of candidates) {
    if (disposed) return;
    if (candidate.start > cursor) {
      const before = element.ownerDocument.createElement("div");
      element.appendChild(before);
      await renderSegment(markdown.slice(cursor, candidate.start), before);
    }
    if (disposed) return;
    const target = element.ownerDocument.createElement("div");
    element.appendChild(target);
    let exactCandidate = null;
    if (typeof snapshot === "string") {
      const parentLine = context.layoutHandle?.location?.lineStart ?? section?.lineStart;
      if (Number.isInteger(parentLine) && parentLine >= 0 && context.layoutItemOffset !== -1) {
        const itemLineOffset = Number.isInteger(context.layoutItemOffset)
          ? (context.layoutSource ?? context.layoutHandle?.source ?? "").slice(0, context.layoutItemOffset).split("\n").length - 1 : 0;
        const fencedLine = !context.layoutHandle?.source && Number.isInteger(context.layoutItemOffset) ? 1 : 0;
        const lineStart = parentLine + fencedLine + itemLineOffset + candidate.lineStart;
        exactCandidate = scanMarkerLayouts(snapshot).find((entry) => entry.lineStart === lineStart
          && entry.body.replace(/\r\n/g, "\n").replace(/\n$/, "") === candidate.body.replace(/\r\n/g, "\n").replace(/\n$/, ""));
      }
    }
    let nestedContext = { ...context, addChild: (child) => owner.addChild(child) };
    if (exactCandidate) nestedContext = markerContext(nestedContext, exactCandidate, snapshot);
    else {
      nestedContext.layoutHandle = { syntax: "markers", direction: candidate.direction, source: candidate.body, location: { lineStart: -1, lineEnd: -1 } };
    }
    await renderLayout(plugin, exactCandidate?.body ?? candidate.body, target, nestedContext, candidate.direction);
    cursor = candidate.end;
  }
  if (!disposed && cursor < markdown.length) {
    const after = element.ownerDocument.createElement("div");
    element.appendChild(after);
    await renderSegment(markdown.slice(cursor), after);
  }
}

function registerMarkerReading(plugin, renderLayout) {
  const containers = new WeakMap();
  const active = new Set();
  const pending = new Map();
  plugin.register(() => {
    for (const cancel of pending.values()) cancel();
    pending.clear();
    for (const coordinator of [...active]) coordinator.dispose();
  });
  const reconcile = (current) => {
    if (current.disposed) return;
    const lines = current.source.split(/\r?\n/);
    const candidates = scanMarkerLayouts(current.source).filter((candidate) => candidate.depth === 0);
    const sections = [...current.sections.values()].sort((a, b) => a.info.lineStart - b.info.lineStart);
    const groups = [];
    for (const candidate of candidates) {
      const entries = sections.filter((entry) => entry.info.lineEnd >= candidate.lineStart && entry.info.lineStart <= candidate.lineEnd);
      if (!entries.length) continue;
      const previous = groups.at(-1);
      if (previous && entries.some((entry) => previous.entries.includes(entry))) {
        previous.candidates.push(candidate);
        previous.entries = [...new Set([...previous.entries, ...entries])];
      } else groups.push({ candidates: [candidate], entries });
    }
    for (const group of groups) {
      const { entries } = group;
      const firstCandidate = group.candidates[0];
      const lastCandidate = group.candidates.at(-1);
      const first = entries[0];
      const last = entries.at(-1);
      if (current.renders.has(firstCandidate.start)) continue;
      if (first.info.lineStart > firstCandidate.lineStart || last.info.lineEnd < lastCandidate.lineEnd) continue;
      if (lines.some((line, index) => index >= firstCandidate.lineStart && index <= lastCandidate.lineEnd
        && line.trim() && !entries.some((entry) => entry.info.lineStart <= index && entry.info.lineEnd >= index))) continue;
      if (entries.some((entry) => (entry.info.lineStart < firstCandidate.lineStart || entry.info.lineEnd > lastCandidate.lineEnd)
        && !entry.element.matches(".el-p"))) continue;
      const host = first.element.ownerDocument.createElement("div");
      host.className = "colsdown-marker-reading";
      const owner = first.owner.addChild(new MarkdownRenderChild(host));
      const hidden = [];
      let disposed = false;
      const render = { entries, dispose: () => {
        if (disposed) return;
        disposed = true;
        first.owner.removeChild(owner); host.remove();
        for (const [node, wasHidden] of hidden) node.hidden = wasHidden;
      } };
      current.renders.set(firstCandidate.start, render);
      first.element.appendChild(host);
      const source = current.source;
      const context = {
        ...first.context, addChild: (child) => owner.addChild(child),
        getSectionInfo: () => ({ text: source, lineStart: first.info.lineStart, lineEnd: last.info.lineEnd }),
        layoutHandle: {
          snapshot: source, location: { lineStart: first.info.lineStart, lineEnd: last.info.lineEnd },
          getSnapshot: async () => {
            const file = plugin.app.vault.getAbstractFileByPath(first.context.sourcePath);
            return file ? plugin.app.vault.cachedRead(file) : null;
          },
        },
      };
      const markdown = (source.match(/[^\n]*\n|[^\n]+$/g) || []).slice(first.info.lineStart, last.info.lineEnd + 1).join("");
      void renderMarkerMarkdown(plugin, markdown, host, context, owner, renderLayout).then(() => {
        if (disposed || current.disposed || current.source !== source) return;
        for (const entry of entries) {
          for (const node of entry.element.children) {
            if (node === host) continue;
            hidden.push([node, node.hidden]); node.hidden = true;
          }
        }
      }).catch((error) => {
        render.dispose();
        if (current.renders.get(firstCandidate.start) === render) current.renders.delete(firstCandidate.start);
        console.error("Colsdown failed to render marker columns.", error);
      });
    }
  };
  const processSection = (element, context) => {
    if (element.closest(".layout-columns-root")) return;
    const info = context.getSectionInfo(element);
    if (!info || typeof info.text !== "string") return;
    const container = element.closest(".markdown-preview-section") || element.parentElement;
    if (!container) {
      if (pending.has(element) || !scanMarkerLayouts(info.text).some((candidate) => candidate.depth === 0)) return;
      // Obsidian can run postprocessors before inserting a section. Observe the
      // public DOM rather than blocking its render promise or guessing a delay.
      const lifecycle = new MarkdownRenderChild(element);
      context.addChild(lifecycle);
      const observer = new element.ownerDocument.defaultView.MutationObserver(() => {
        if (!element.parentElement) return;
        cancel();
        processSection(element, context);
      });
      const cancel = () => { observer.disconnect(); pending.delete(element); };
      pending.set(element, cancel);
      lifecycle.register(cancel);
      observer.observe(element.ownerDocument, { childList: true, subtree: true });
      return;
    }
    let documents = containers.get(container);
    if (!documents) { documents = new Map(); containers.set(container, documents); }
    const key = context.docId ?? context.sourcePath;
    let current = documents.get(key);
    if (!current) {
      if (!scanMarkerLayouts(info.text).some((candidate) => candidate.depth === 0)) return;
      current = { source: info.text, sections: new Map(), renders: new Map(), disposed: false };
      current.dispose = () => {
        if (current.disposed) return;
        current.disposed = true;
        for (const render of current.renders.values()) render.dispose();
        current.renders.clear(); active.delete(current);
      };
      documents.set(key, current); active.add(current);
    }
    if (current.source !== info.text) {
      for (const render of current.renders.values()) render.dispose();
      current.renders.clear(); current.source = info.text;
      for (const [node, entry] of current.sections) {
        const updated = entry.context.getSectionInfo(node);
        if (!container.contains(node) || !updated || updated.text !== info.text) current.sections.delete(node);
        else entry.info = updated;
      }
    }
    if (!current.sections.has(element)) {
      const owner = new MarkdownRenderChild(element);
      context.addChild(owner);
      const entry = { element, info, context, owner };
      current.sections.set(element, entry);
      owner.register(() => {
        current.sections.delete(element);
        for (const [start, render] of current.renders) {
          if (render.entries.includes(entry)) { render.dispose(); current.renders.delete(start); }
        }
        if (current.sections.size === 0) {
          current.dispose();
          if (documents.get(key) === current) documents.delete(key);
        }
      });
    } else current.sections.get(element).info = info;
    reconcile(current);
  };
  plugin.registerMarkdownPostProcessor(processSection);
}
module.exports = { layoutItemOffsets, markerContext, registerMarkerReading, renderMarkerMarkdown };
