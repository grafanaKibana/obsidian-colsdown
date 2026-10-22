const { parseLayout, parseLayoutSource, splitLines } = require("./layout.cjs");

const { scanMarkerLayouts, scanEditorLayouts, replaceMarkerWidth, parseMarkerLayout } = require("./markers.cjs");

const NEW_COLUMN_PLACEHOLDER = "New column";
const ERROR_PREFIX = "Colsdown cannot edit source: ";

function sourceError(message) {
  return new Error(`${ERROR_PREFIX}${message}`);
}

function normalizeRenderedBody(source) {
  const normalized = source.replace(/\r\n?|\n/g, "\n");
  return normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
}

function scanLayoutFences(source) {
  return scanEditorLayouts(source).filter((candidate) => candidate.syntax === "fenced");
}

function selectLayoutFence(snapshot, renderedSource, sectionInfo) {
  const expected = normalizeRenderedBody(renderedSource);
  const candidates = scanLayoutFences(snapshot)
    .filter((candidate) => (
      candidate.language === "colsdown" && normalizeRenderedBody(candidate.body) === expected
    ));
  if (candidates.length === 0) {
    throw sourceError("the rendered layout no longer has an exact fenced source match.");
  }

  if (sectionInfo && Number.isInteger(sectionInfo.lineStart) && Number.isInteger(sectionInfo.lineEnd)) {
    const exact = candidates.filter((candidate) => (
      candidate.lineStart === sectionInfo.lineStart && candidate.lineEnd === sectionInfo.lineEnd
    ));
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      throw sourceError("the section maps to more than one layout fence.");
    }
  }

  if (candidates.length === 1) return candidates[0];
  throw sourceError("multiple identical layout fences match; reopen the note and edit the intended block.");
}

function selectMarkerLayout(snapshot, source, sectionInfo, direction = "row") {
  const candidates = scanMarkerLayouts(snapshot).filter((candidate) => (
    candidate.direction === direction && normalizeRenderedBody(candidate.body) === normalizeRenderedBody(source)
  ));
  if (sectionInfo && Number.isInteger(sectionInfo.lineStart) && Number.isInteger(sectionInfo.lineEnd)) {
    const exact = candidates.filter((candidate) => candidate.lineStart === sectionInfo.lineStart && candidate.lineEnd === sectionInfo.lineEnd);
    if (exact.length === 1) return exact[0];
    throw sourceError("the marker section no longer has an exact source match.");
  }
  if (candidates.length === 1) return candidates[0];
  throw sourceError(candidates.length ? "multiple identical marker layouts match; reopen the intended layout." : "the rendered marker layout no longer has an exact source match.");
}

function appendMarkerColumn(source, sourceIndent = 0) {
  const candidate = scanMarkerLayouts(source, { sourceIndent }).find((region) => region.start === 0 && region.end === source.length);
  const parsed = parseMarkerLayout(source, undefined, sourceIndent);
  if (!candidate || !parsed.markers.length) throw sourceError("the marker layout is incomplete.");
  const normalized = reserveAutoColumnShare(source, parsed, "markers");
  const lines = splitLines(normalized);
  const ending = lines.pop();
  let prefix = lines.join("");
  const newline = preferredLineEnding(source);
  const indent = " ".repeat(sourceIndent);
  if (parsed.items.length === 1 && parsed.markers[0].implicit && parsed.items[0].markdown.trim() === "") {
    const contentStart = parsed.markers[0].bodyStart;
    prefix = prefix.slice(0, contentStart) + `${indent}${parsed.separator}${newline}` + prefix.slice(contentStart);
  }
  const updated = prefix + `${indent}${parsed.separator}${newline}${indent}${NEW_COLUMN_PLACEHOLDER}${newline}` + ending;
  const reparsed = parseMarkerLayout(updated, undefined, sourceIndent);
  if (reparsed.items.length !== parsed.items.length + 1) throw sourceError("a column could not be added safely.");
  return updated;
}

function formatPercentage(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 100) {
    throw sourceError("every saved column width must be a finite percentage greater than 0 and at most 100.");
  }
  const rounded = Number(number.toFixed(4));
  if (rounded <= 0) throw sourceError("saved column widths must remain greater than 0 after rounding.");
  return rounded.toString();
}

function markerReplacement(line, separator, percentage) {
  const escaped = separator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^(\\s*${escaped})(\\s*)(.*?)(\\s*)$`).exec(line);
  if (!match) throw sourceError("a saved width marker no longer matches the layout separator.");
  const spacing = match[2] || " ";
  return `${match[1]}${spacing}${percentage}%${match[4]}`;
}

function reserveAutoColumnShare(source, parsed, syntax = "fenced") {
  if (!parsed.items.every((item) => item.width.kind === "percent")) return source;
  if (parsed.markers.length !== parsed.items.length) {
    throw sourceError("the layout markers do not match its rendered columns.");
  }
  const total = parsed.items.reduce((sum, item) => sum + item.width.value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw sourceError("the existing percentage widths cannot be normalized safely.");
  }
  const reservedTotal = 100 * parsed.items.length / (parsed.items.length + 1);
  const percentages = parsed.items.map((item) => (
    formatPercentage(item.width.value * reservedTotal / total)
  ));
  let updated = source;
  for (let index = parsed.markers.length - 1; index >= 0; index -= 1) {
    const marker = parsed.markers[index];
    const replacement = syntax === "markers" ? replaceMarkerWidth(marker.line, percentages[index])
      : markerReplacement(marker.line, parsed.separator, percentages[index]);
    updated = updated.slice(0, marker.start) + replacement + updated.slice(marker.end);
  }
  return updated;
}

function preferredLineEnding(source) {
  const match = /\r\n|\r|\n/.exec(source);
  return match ? match[0] : "\n";
}

function rewriteLayoutWidths(source, percentages, configuredSeparator, syntax = "fenced", sourceIndent = 0) {
  const parsed = parseLayoutSource(source, "row", configuredSeparator, syntax, sourceIndent);
  if (parsed.items.length !== percentages.length) {
    throw sourceError(`the layout has ${parsed.items.length} columns, but ${percentages.length} widths were supplied.`);
  }
  const formatted = percentages.map(formatPercentage);
  const total = percentages.reduce((sum, value) => sum + Number(value), 0);
  if (!Number.isFinite(total) || Math.abs(total - 100) > 0.0001) {
    throw sourceError("saved column widths must add up to 100%.");
  }

  const firstMarker = parsed.markers[0];
  const implicitFirst = syntax !== "markers" && Boolean(firstMarker && source.slice(0, firstMarker.start).trim() !== "");
  const markerOffset = implicitFirst ? 1 : 0;
  if (parsed.markers.length !== percentages.length - markerOffset) {
    throw sourceError("the layout markers do not match its rendered columns.");
  }

  let updated = source;
  for (let index = parsed.markers.length - 1; index >= 0; index -= 1) {
    const marker = parsed.markers[index];
    if (marker.implicit) continue;
    const percentage = formatted[index + markerOffset];
    const replacement = syntax === "markers" ? replaceMarkerWidth(marker.line, percentage)
      : markerReplacement(marker.line, parsed.separator, percentage);
    updated = updated.slice(0, marker.start) + replacement + updated.slice(marker.end);
  }
  if (implicitFirst) {
    updated = `${" ".repeat(sourceIndent)}${parsed.separator} ${formatted[0]}%${preferredLineEnding(source)}${updated}`;
  }
  return updated;
}

function fileForPath(app, path) {
  const file = app?.vault?.getAbstractFileByPath?.(path);
  if (!file || file.path !== path) throw sourceError(`the note “${path}” is unavailable or was renamed.`);
  return file;
}

function sourceEditors(app, file) {
  const leaves = app?.workspace?.getLeavesOfType?.("markdown") || [];
  const editors = [];
  for (const leaf of leaves) {
    const view = leaf?.view;
    if (!view || view.file?.path !== file.path) continue;
    if (typeof view.getMode !== "function" || view.getMode() !== "source") continue;
    if (view.file !== file) throw sourceError("a source view refers to a different note identity at the same path.");
    if (!view.editor || typeof view.editor.getValue !== "function") continue;
    editors.push(view.editor);
  }
  if (editors.length > 1) {
    throw sourceError("this note is open in multiple source panes; close the extra source panes before editing.");
  }
  return editors;
}

function sharedEditorSnapshot(editors) {
  if (editors.length === 0) return null;
  const snapshot = editors[0].getValue();
  if (editors.some((editor) => editor.getValue() !== snapshot)) {
    throw sourceError("open source editors for this note contain different text; reconcile them before editing.");
  }
  return snapshot;
}

function offsetToPosition(source, offset) {
  const before = source.slice(0, offset).split(/\r\n|\r|\n/);
  return { line: before.length - 1, ch: before[before.length - 1].length };
}

function replaceEditorRange(editor, snapshot, start, end, replacement) {
  const position = typeof editor.offsetToPos === "function"
    ? (offset) => editor.offsetToPos(offset)
    : (offset) => offsetToPosition(snapshot, offset);
  const change = { from: position(start), to: position(end), text: replacement };
  if (typeof editor.transaction === "function") {
    editor.transaction({ changes: [change] });
    return;
  }
  if (typeof editor.replaceRange === "function") {
    editor.replaceRange(replacement, change.from, change.to);
    return;
  }
  throw sourceError("the source editor does not support a public edit transaction.");
}

async function prepareSourceEdit(app, context, element, source, separator) {
  const path = context?.sourcePath;
  if (typeof path !== "string" || path.length === 0) throw sourceError("the rendered block has no note path.");
  const handle = context?.layoutHandle;
  const syntax = handle?.syntax || "fenced";
  const direction = handle?.direction || "row";
  const renderedSource = handle?.source ?? source;
  const sectionInfo = handle?.location || context?.getSectionInfo?.(element) || null;
  const file = fileForPath(app, path);
  const editors = sourceEditors(app, file);
  const editorSnapshot = sharedEditorSnapshot(editors);
  const authority = editorSnapshot === null ? "vault" : "editor";
  const snapshot = editorSnapshot === null ? await app.vault.read(file) : editorSnapshot;
  if (typeof snapshot !== "string") throw sourceError("the note source could not be read.");
  const candidate = syntax === "markers"
    ? selectMarkerLayout(snapshot, renderedSource, sectionInfo, direction)
    : selectLayoutFence(snapshot, renderedSource, sectionInfo);
  return {
    authority,
    syntax,
    direction,
    candidate,
    file,
    path,
    separator,
    snapshot,
    source: renderedSource,
  };
}

async function commitSourceEdit(app, prepared, updateBody) {
  if (!prepared || typeof prepared.snapshot !== "string" || !prepared.candidate) {
    throw sourceError("the edit has no valid source snapshot.");
  }
  const file = fileForPath(app, prepared.path);
  if (file !== prepared.file) throw sourceError("the note identity changed during the source edit.");

  const body = prepared.snapshot.slice(prepared.candidate.bodyStart, prepared.candidate.bodyEnd);
  const updatedBody = updateBody(body);
  const updatedSnapshot = prepared.snapshot.slice(0, prepared.candidate.bodyStart)
    + updatedBody
    + prepared.snapshot.slice(prepared.candidate.bodyEnd);
  const previousLocation = { lineStart: prepared.candidate.lineStart, lineEnd: prepared.candidate.lineEnd };
  const location = {
    lineStart: previousLocation.lineStart,
    lineEnd: previousLocation.lineEnd + splitLines(updatedBody).length - splitLines(body).length,
  };
  const editors = sourceEditors(app, file);
  const editorSnapshot = sharedEditorSnapshot(editors);
  const authority = editorSnapshot === null ? "vault" : "editor";
  if (authority !== prepared.authority) {
    throw sourceError("the note’s source editing mode changed during the source edit.");
  }
  if (authority === "editor" && editorSnapshot !== prepared.snapshot) {
    throw sourceError("the note changed during the source edit.");
  }
  if (updatedBody === body) {
    if (authority === "vault" && await app.vault.read(file) !== prepared.snapshot) {
      throw sourceError("the note changed during the source edit.");
    }
    return { source: updatedBody, previousSource: body, changed: false, authority, location, previousLocation,
      previousSnapshot: prepared.snapshot, snapshot: updatedSnapshot };
  }

  if (authority === "editor") {
    replaceEditorRange(
      editors[0],
      prepared.snapshot,
      prepared.candidate.bodyStart,
      prepared.candidate.bodyEnd,
      updatedBody,
    );
  } else {
    await app.vault.process(file, (current) => {
      const currentFile = fileForPath(app, prepared.path);
      if (currentFile !== prepared.file) throw sourceError("the note identity changed during the source edit.");
      if (sourceEditors(app, currentFile).length > 0) {
        throw sourceError("the note’s source editing mode changed during the source edit.");
      }
      if (current !== prepared.snapshot) throw sourceError("the note changed during the source edit.");
      return updatedSnapshot;
    });
  }
  return { source: updatedBody, previousSource: body, changed: true, authority, location, previousLocation,
    previousSnapshot: prepared.snapshot, snapshot: updatedSnapshot };
}

async function commitWidths(app, prepared, percentages, separator = prepared?.separator) {
  return commitSourceEdit(
    app,
    prepared,
    (body) => rewriteLayoutWidths(body, percentages, separator, prepared.syntax, prepared.candidate.sourceIndent),
  );
}

function appendAutoColumn(source, configuredSeparator, syntax = "fenced", sourceIndent = 0) {
  if (syntax === "markers") return appendMarkerColumn(source, sourceIndent);
  const parsed = parseLayout(source, "row", configuredSeparator, sourceIndent);
  const normalizedSource = reserveAutoColumnShare(source, parsed);
  const lineEnding = preferredLineEnding(source);
  const boundary = `${" ".repeat(sourceIndent)}${parsed.separator}${lineEnding}`;
  const needsInitialBoundary = parsed.markers.length === 0 && source.trim() === "";
  const separatorLine = normalizedSource === "" || /(?:\r\n|\r|\n)$/.test(normalizedSource)
    ? boundary
    : `${lineEnding}${boundary}`;
  const content = `${" ".repeat(sourceIndent)}${NEW_COLUMN_PLACEHOLDER}${lineEnding}`;
  const updated = normalizedSource + (needsInitialBoundary ? boundary : "") + separatorLine + content;
  const reparsed = parseLayout(updated, "row", configuredSeparator, sourceIndent);
  const last = reparsed.items[reparsed.items.length - 1];
  if (
    reparsed.items.length !== parsed.items.length + 1
    || reparsed.separator !== parsed.separator
    || last?.width?.kind !== "auto"
    || last.markdown !== content
  ) {
    throw sourceError("a column could not be added safely; check nested code fences in the layout.");
  }
  return updated;
}

async function commitAddedColumn(app, prepared, separator = prepared?.separator) {
  return commitSourceEdit(app, prepared, (body) => appendAutoColumn(body, separator, prepared.syntax, prepared.candidate.sourceIndent));
}

module.exports = {
  NEW_COLUMN_PLACEHOLDER,
  appendAutoColumn,
  selectMarkerLayout,
  commitAddedColumn,
  commitWidths,
  formatPercentage,
  normalizeRenderedBody,
  offsetToPosition,
  prepareSourceEdit,
  rewriteLayoutWidths,
  scanLayoutFences,
  selectLayoutFence,
};
