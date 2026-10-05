const { splitLines } = require("./layout.cjs");
const { normalizeRenderedBody, scanLayoutFences } = require("./source-edits.cjs");

const LAYOUT_LANGUAGES = new Set(["colsdown", "stack"]);
const MAX_NESTING_DEPTH = 6;

function lineBody(line) {
  return line.replace(/(?:\r\n|\r|\n)$/, "");
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

function findUnescaped(source, token, from) {
  let index = source.indexOf(token, from);
  while (index >= 0) {
    if (!isEscaped(source, index)) return index;
    index = source.indexOf(token, index + token.length);
  }
  return -1;
}

function maskComments(line, commentKind) {
  let output = "";
  let cursor = 0;
  while (cursor < line.length) {
    if (commentKind) {
      const token = commentKind === "html" ? "-->" : "%%";
      const close = commentKind === "html"
        ? line.indexOf(token, cursor)
        : findUnescaped(line, token, cursor);
      if (close < 0) return { text: output + " ".repeat(line.length - cursor), commentKind };
      output += " ".repeat(close + token.length - cursor);
      cursor = close + token.length;
      commentKind = null;
      continue;
    }
    const searchable = maskInlineCode(line);
    const htmlOpen = searchable.indexOf("<!--", cursor);
    const obsidianOpen = findUnescaped(searchable, "%%", cursor);
    const open = htmlOpen < 0 ? obsidianOpen
      : obsidianOpen < 0 ? htmlOpen
        : Math.min(htmlOpen, obsidianOpen);
    if (open < 0) return { text: output + line.slice(cursor), commentKind: null };
    const isHtml = open === htmlOpen;
    const length = isHtml ? 4 : 2;
    output += line.slice(cursor, open) + " ".repeat(length);
    cursor = open + length;
    commentKind = isHtml ? "html" : "obsidian";
  }
  return { text: output, commentKind };
}

function maskInlineCode(line) {
  let output = line;
  let cursor = 0;
  while (cursor < line.length) {
    const open = line.indexOf("`", cursor);
    if (open < 0) break;
    let length = 1;
    while (line[open + length] === "`") length += 1;
    let close = open + length;
    while (close < line.length) {
      close = line.indexOf("`".repeat(length), close);
      if (close < 0) break;
      if (line[close - 1] !== "`" && line[close + length] !== "`") break;
      close += length;
    }
    if (close < 0) break;
    output = output.slice(0, open) + " ".repeat(close + length - open) + output.slice(close + length);
    cursor = close + length;
  }
  return output;
}

function normalizeFootnoteId(id) {
  return String(id).trim().replace(/\s+/g, " ").toLowerCase();
}

function definitionStart(line) {
  const match = /^ {0,3}\[\^([^\]\r\n]+)\]:/.exec(line);
  if (!match) return null;
  const id = normalizeFootnoteId(match[1]);
  return id ? { id } : null;
}

function continuationIndent(line, afterBlank) {
  if (line.startsWith("\t")) return true;
  return /^ */.exec(line)[0].length >= (afterBlank ? 4 : 2);
}

function definitionEnd(lines, from, to) {
  let index = from + 1;
  let end = index;
  let blankStart = null;
  while (index < to) {
    const body = lineBody(lines[index]);
    if (body.trim() === "") {
      if (blankStart === null) blankStart = index;
      index += 1;
      continue;
    }
    if (!continuationIndent(body, blankStart !== null)) break;
    end = index + 1;
    blankStart = null;
    index += 1;
  }
  return blankStart === null ? end : Math.min(end, blankStart);
}

function frontmatterEnd(lines) {
  if (!/^\uFEFF?---[ \t]*$/.test(lineBody(lines[0] ?? ""))) return 0;
  for (let index = 1; index < lines.length; index += 1) {
    if (/^---[ \t]*$/.test(lineBody(lines[index]))) return index + 1;
  }
  return 0;
}

// Project Markdown containers only for reads. Source-edit offsets always use the original note.
function projectMarkdown(source) {
  const lines = splitLines(source);
  const containers = [];
  const yamlEnd = frontmatterEnd(lines);
  let listIndents = [];
  let quoteDepth = 0;
  let fence = null;
  let definitionIndent = null;
  let commentKind = null;
  for (let index = yamlEnd; index < lines.length; index += 1) {
    const raw = lines[index];
    const ending = raw.slice(lineBody(raw).length);
    let body = lineBody(raw);
    let quotes = 0;
    const quoteLimit = fence ? fence.quotes : Infinity;
    while (quotes < quoteLimit) {
      const match = /^ {0,3}>[ \t]?/.exec(body);
      if (!match) break;
      body = body.slice(match[0].length);
      quotes += 1;
    }
    if (!fence && quotes !== quoteDepth) {
      listIndents = [];
      definitionIndent = null;
    }
    quoteDepth = quotes;
    // Tabs occupy four-column stops in Markdown indentation.
    const originalBody = body;
    body = body.replace(/^[ \t]+/, (indent) => {
      let width = 0;
      for (const character of indent) width += character === "\t" ? 4 - width % 4 : 1;
      return " ".repeat(width);
    });
    const indent = /^ */.exec(body)[0].length;
    let base;
    if (fence) base = fence.base;
    else {
      if (body.trim()) {
        while (listIndents.length && indent < listIndents.at(-1)) listIndents.pop();
      }
      base = definitionIndent ?? listIndents.at(-1) ?? 0;
    }
    const compatible = quotes === (fence?.quotes ?? quotes) && (indent >= base || body.trim() === "");
    const text = base === 0 ? originalBody : compatible ? body.slice(Math.min(base, indent)) : body;
    const signature = compatible ? `${quotes}:${base}` : null;
    containers[index] = { signature, contained: quotes > 0 || base > 0 };
    if (fence) {
      lines[index] = text + ending;
      if (compatible && isClosingFence(text, fence)) fence = null;
      continue;
    }
    lines[index] = text + ending;
    const masked = maskComments(text, commentKind);
    commentKind = masked.commentKind;
    const open = openingFence(masked.text);
    if (open) {
      fence = { ...open, quotes, base };
      definitionIndent = null;
      continue;
    }
    if (definitionStart(masked.text)) definitionIndent = base;
    else if (text.trim() && !continuationIndent(text, false)) definitionIndent = null;
    if (definitionIndent === null) {
      const marker = /^( {0,3})(?:[-+*]|\d{1,9}[.)])([ \t]+)(?=\S)/.exec(masked.text);
      if (marker && marker[2].length <= 4) listIndents.push(base + marker[0].length);
    }
  }
  // YAML is not Markdown and cannot supply a layout's provenance.
  for (let index = 0; index < yamlEnd; index += 1) {
    lines[index] = lines[index].slice(lineBody(lines[index]).length);
  }
  return { lines, containers };
}

function footnoteLayoutFences(source, offset = 0, depth = 0) {
  if (depth > MAX_NESTING_DEPTH) return [];
  const projected = projectMarkdown(source);
  const found = [];
  for (const candidate of scanLayoutFences(projected.lines.join(""))) {
    if (candidate.depth !== 0) continue;
    const start = projected.containers[candidate.lineStart];
    const end = projected.containers[candidate.lineEnd];
    if (!start || !end || start.signature === null || start.signature !== end.signature) continue;
    const indent = /^ */.exec(lineBody(projected.lines[candidate.lineStart]))[0].length;
    const body = splitLines(candidate.body).map((line) => line.replace(new RegExp(`^ {0,${indent}}`), "")).join("");
    found.push({ ...candidate, body, contained: start.contained, lineStart: offset + candidate.lineStart, lineEnd: offset + candidate.lineEnd });
    found.push(...footnoteLayoutFences(body, offset + candidate.lineStart + 1, depth + 1));
  }
  return found;
}

function collectDefinitions(source, includeLayouts, depth = 0) {
  const { lines } = projectMarkdown(typeof source === "string" ? source : "");
  const definitions = new Map();

  function scan(from, to, depth) {
    let index = from;
    let commentKind = null;
    while (index < to) {
      const body = lineBody(lines[index]);
      const masked = maskComments(body, commentKind);
      commentKind = masked.commentKind;
      const open = openingFence(masked.text);
      if (open) {
        let close = index + 1;
        while (close < to && !isClosingFence(lineBody(lines[close]), open)) close += 1;
        if (close >= to) return;
        if (includeLayouts && LAYOUT_LANGUAGES.has(open.language) && depth < MAX_NESTING_DEPTH) {
          const nested = collectDefinitions(lines.slice(index + 1, close).join(""), includeLayouts, depth + 1);
          for (const [id, raw] of nested) definitions.set(id, raw);
        }
        index = close + 1;
        continue;
      }
      const definition = definitionStart(masked.text);
      if (!definition) {
        index += 1;
        continue;
      }
      const end = definitionEnd(lines, index, to);
      definitions.set(definition.id, lines.slice(index, end).join(""));
      index = Math.max(index + 1, end);
    }
  }

  scan(0, lines.length, depth);
  return definitions;
}

function collectFootnoteDefinitions(source) {
  return collectDefinitions(source, true);
}

function isEscaped(source, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function lineHasFootnoteReference(line) {
  const visible = maskInlineCode(line);
  const pattern = /\[\^([^\]\r\n]+)\]/g;
  let match;
  while ((match = pattern.exec(visible))) {
    if (isEscaped(visible, match.index)) continue;
    if (visible[match.index - 1] === "!" && !isEscaped(visible, match.index - 1)) continue;
    if (visible[pattern.lastIndex] === ":") continue;
    if (normalizeFootnoteId(match[1])) return true;
  }
  return false;
}

function hasFootnoteReferences(markdown) {
  const { lines } = projectMarkdown(typeof markdown === "string" ? markdown : "");
  let fence = null;
  let commentKind = null;
  for (const raw of lines) {
    const body = lineBody(raw);
    if (fence) {
      if (isClosingFence(body, fence)) fence = null;
      continue;
    }
    const masked = maskComments(body, commentKind);
    commentKind = masked.commentKind;
    const open = openingFence(masked.text);
    if (open) {
      fence = open;
      continue;
    }
    if (/^(?: {4}|\t)/.test(masked.text)) continue;
    if (lineHasFootnoteReference(masked.text)) return true;
  }
  return false;
}

function preferredLineEnding(source) {
  return /\r\n/.test(source) ? "\r\n" : /\r/.test(source) ? "\r" : "\n";
}

function appendWithBlankLine(source, addition, lineEnding) {
  if (source === "") return addition;
  if (/(?:\r\n|\r|\n){2}$/.test(source)) return source + addition;
  if (/(?:\r\n|\r|\n)$/.test(source)) return source + lineEnding + addition;
  return source + lineEnding + lineEnding + addition;
}

function hydrateFootnotes(markdown, definitions) {
  if (!(definitions instanceof Map) || definitions.size === 0) return markdown;
  const own = collectDefinitions(markdown, false);
  const missing = [];
  for (const [id, raw] of definitions) {
    const normalized = normalizeFootnoteId(id);
    if (!normalized || own.has(normalized) || typeof raw !== "string" || raw === "") continue;
    own.set(normalized, raw);
    missing.push(raw);
  }
  if (missing.length === 0) return markdown;
  const lineEnding = preferredLineEnding(markdown);
  let hydrated = markdown;
  for (const definition of missing) hydrated = appendWithBlankLine(hydrated, definition, lineEnding);
  return hydrated;
}

function isSectionStart(snapshot, start) {
  if (start === 0) return true;
  if (snapshot[start - 1] === "\n") return true;
  return snapshot[start - 1] === "\r" && snapshot[start] !== "\n";
}

function isSectionEnd(snapshot, end) {
  if (end === snapshot.length) return true;
  if (snapshot[end] === "\r") return true;
  if (snapshot[end] === "\n" && snapshot[end - 1] !== "\r") return true;
  if (snapshot[end - 1] === "\n") return true;
  return snapshot[end - 1] === "\r" && snapshot[end] !== "\n";
}

function mapSectionLines(snapshot, sectionInfo) {
  if (!sectionInfo
    || !Number.isInteger(sectionInfo.lineStart)
    || !Number.isInteger(sectionInfo.lineEnd)
    || typeof sectionInfo.text !== "string") return null;

  const sectionLines = splitLines(sectionInfo.text);
  if (sectionInfo.lineStart < 0
    || sectionInfo.lineEnd < sectionInfo.lineStart
    || sectionInfo.lineEnd >= sectionLines.length) return null;

  if (sectionInfo.text === snapshot) {
    return { lineStart: sectionInfo.lineStart, lineEnd: sectionInfo.lineEnd };
  }
  if (sectionInfo.text === "") return null;

  const start = snapshot.indexOf(sectionInfo.text);
  if (start < 0 || snapshot.indexOf(sectionInfo.text, start + 1) >= 0) return null;
  const end = start + sectionInfo.text.length;
  if (!isSectionStart(snapshot, start) || !isSectionEnd(snapshot, end)) return null;

  const lineOffset = start === 0 ? 0 : splitLines(snapshot.slice(0, start)).length;
  return {
    lineStart: lineOffset + sectionInfo.lineStart,
    lineEnd: lineOffset + sectionInfo.lineEnd,
  };
}

async function readFootnoteDefinitions(app, context, element, source, direction, validatedLocation = null) {
  if (!hasFootnoteReferences(source)) return null;
  const path = context?.sourcePath;
  if (typeof path !== "string" || path.length === 0) return null;
  const file = app?.vault?.getAbstractFileByPath?.(path);
  if (!file || file.path !== path || typeof app?.vault?.cachedRead !== "function") return null;
  try {
    const snapshot = await app.vault.cachedRead(file);
    if (typeof snapshot !== "string") return null;
    const language = direction === "column" ? "stack" : "colsdown";
    const expected = normalizeRenderedBody(source);
    const candidates = footnoteLayoutFences(snapshot).filter((candidate) => (
      candidate.language === language && normalizeRenderedBody(candidate.body) === expected
    ));
    let exact;
    if (validatedLocation !== null) {
      if (!Number.isInteger(validatedLocation?.lineStart)
        || !Number.isInteger(validatedLocation?.lineEnd)
        || validatedLocation.lineStart < 0
        || validatedLocation.lineEnd < validatedLocation.lineStart) return null;
      exact = candidates.filter((candidate) => (
        candidate.lineStart === validatedLocation.lineStart
        && candidate.lineEnd === validatedLocation.lineEnd
      ));
    } else {
      const sectionInfo = context?.getSectionInfo?.(element) || null;
      if (!sectionInfo) {
        if (candidates.length !== 1) return null;
        exact = candidates;
      } else {
        const mapped = mapSectionLines(snapshot, sectionInfo);
        if (!mapped) return null;
        exact = candidates.filter((candidate) => (
          (candidate.lineStart === mapped.lineStart && candidate.lineEnd === mapped.lineEnd)
          || (candidate.contained && candidate.lineStart >= mapped.lineStart && candidate.lineEnd <= mapped.lineEnd)
        ));
      }
    }
    if (exact.length !== 1) return null;
    return {
      definitions: collectFootnoteDefinitions(snapshot),
      location: { lineStart: exact[0].lineStart, lineEnd: exact[0].lineEnd },
    };
  } catch {
    return null;
  }
}

module.exports = {
  collectFootnoteDefinitions,
  hasFootnoteReferences,
  hydrateFootnotes,
  readFootnoteDefinitions,
};
