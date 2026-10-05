const { parseLayout, splitLines } = require("./layout.cjs");

const LAYOUT_LANGUAGES = new Set(["colsdown", "stack"]);
const NEW_COLUMN_PLACEHOLDER = "New column";
const ERROR_PREFIX = "Colsdown cannot edit source: ";

function sourceError(message) {
  return new Error(`${ERROR_PREFIX}${message}`);
}

function normalizeRenderedBody(source) {
  const normalized = source.replace(/\r\n?|\n/g, "\n");
  return normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
}

function sourceLines(source) {
  const lines = splitLines(source);
  let offset = 0;
  return lines.map((raw, index) => {
    const start = offset;
    offset += raw.length;
    return {
      index,
      raw,
      start,
      end: offset,
      body: raw.replace(/(?:\r\n|\r|\n)$/, ""),
    };
  });
}

function openingFence(line) {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const marker = match[2];
  const info = match[3].trim();
  if (marker[0] === "`" && info.includes("`")) return null;
  return {
    character: marker[0],
    length: marker.length,
    language: (info.split(/\s+/, 1)[0] || "").toLowerCase(),
  };
}

function isClosingFence(line, open) {
  const match = /^( {0,3})(`+|~+)[ \t]*$/.exec(line);
  return Boolean(match && match[2][0] === open.character && match[2].length >= open.length);
}

function scanLayoutFences(source) {
  const lines = sourceLines(source);
  const found = [];

  function scan(from, to, depth) {
    let index = from;
    while (index < to) {
      const open = openingFence(lines[index].body);
      if (!open) {
        index += 1;
        continue;
      }
      let close = index + 1;
      while (close < to && !isClosingFence(lines[close].body, open)) close += 1;
      if (close >= to) return;

      if (LAYOUT_LANGUAGES.has(open.language)) {
        const candidate = {
          language: open.language,
          depth,
          start: lines[index].start,
          end: lines[close].end,
          bodyStart: lines[index].end,
          bodyEnd: lines[close].start,
          lineStart: lines[index].index,
          lineEnd: lines[close].index,
        };
        candidate.body = source.slice(candidate.bodyStart, candidate.bodyEnd);
        candidate.fence = source.slice(candidate.start, candidate.end);
        found.push(candidate);
        scan(index + 1, close, depth + 1);
      }
      index = close + 1;
    }
  }

  scan(0, lines.length, 0);
  return found;
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

function reserveAutoColumnShare(source, parsed) {
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
    const replacement = markerReplacement(marker.line, parsed.separator, percentages[index]);
    updated = updated.slice(0, marker.start) + replacement + updated.slice(marker.end);
  }
  return updated;
}

function preferredLineEnding(source) {
  const match = /\r\n|\r|\n/.exec(source);
  return match ? match[0] : "\n";
}

function rewriteLayoutWidths(source, percentages, configuredSeparator) {
  const parsed = parseLayout(source, "row", configuredSeparator);
  if (parsed.items.length !== percentages.length) {
    throw sourceError(`the layout has ${parsed.items.length} columns, but ${percentages.length} widths were supplied.`);
  }
  const formatted = percentages.map(formatPercentage);
  const total = percentages.reduce((sum, value) => sum + Number(value), 0);
  if (!Number.isFinite(total) || Math.abs(total - 100) > 0.0001) {
    throw sourceError("saved column widths must add up to 100%.");
  }

  const firstMarker = parsed.markers[0];
  const implicitFirst = Boolean(firstMarker && source.slice(0, firstMarker.start).trim() !== "");
  const markerOffset = implicitFirst ? 1 : 0;
  if (parsed.markers.length !== percentages.length - markerOffset) {
    throw sourceError("the layout markers do not match its rendered columns.");
  }

  let updated = source;
  for (let index = parsed.markers.length - 1; index >= 0; index -= 1) {
    const marker = parsed.markers[index];
    const percentage = formatted[index + markerOffset];
    const replacement = markerReplacement(marker.line, parsed.separator, percentage);
    updated = updated.slice(0, marker.start) + replacement + updated.slice(marker.end);
  }
  if (implicitFirst) {
    updated = `${parsed.separator} ${formatted[0]}%${preferredLineEnding(source)}${updated}`;
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
  const sectionInfo = context?.getSectionInfo?.(element) || null;
  const file = fileForPath(app, path);
  const editors = sourceEditors(app, file);
  const editorSnapshot = sharedEditorSnapshot(editors);
  const authority = editorSnapshot === null ? "vault" : "editor";
  const snapshot = editorSnapshot === null ? await app.vault.read(file) : editorSnapshot;
  if (typeof snapshot !== "string") throw sourceError("the note source could not be read.");
  const candidate = selectLayoutFence(snapshot, source, sectionInfo);
  return {
    authority,
    candidate,
    file,
    path,
    separator,
    snapshot,
    source,
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
    (body) => rewriteLayoutWidths(body, percentages, separator),
  );
}

function appendAutoColumn(source, configuredSeparator) {
  const parsed = parseLayout(source, "row", configuredSeparator);
  const normalizedSource = reserveAutoColumnShare(source, parsed);
  const lineEnding = preferredLineEnding(source);
  const boundary = `${parsed.separator}${lineEnding}`;
  const needsInitialBoundary = parsed.markers.length === 0 && source.trim() === "";
  const separatorLine = normalizedSource === "" || /(?:\r\n|\r|\n)$/.test(normalizedSource)
    ? boundary
    : `${lineEnding}${boundary}`;
  const content = `${NEW_COLUMN_PLACEHOLDER}${lineEnding}`;
  const updated = normalizedSource + (needsInitialBoundary ? boundary : "") + separatorLine + content;
  const reparsed = parseLayout(updated, "row", configuredSeparator);
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
  return commitSourceEdit(app, prepared, (body) => appendAutoColumn(body, separator));
}

module.exports = {
  NEW_COLUMN_PLACEHOLDER,
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
