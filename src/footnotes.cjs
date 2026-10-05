const { splitLines } = require("./layout.cjs");
const { normalizeRenderedBody } = require("./source-edits.cjs");

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

function maskComments(line, commentKind, inlineHtmlCloses = true) {
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
    let htmlOpen = findUnescaped(searchable, "<!--", cursor);
    if (!inlineHtmlCloses && htmlOpen >= 0 && line.indexOf("-->", htmlOpen + 4) < 0) htmlOpen = -1;
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
    if (isEscaped(line, open)) {
      cursor = open + 1;
      continue;
    }
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

const HTML_BLOCK_TAGS = [
  "address", "article", "aside", "base", "basefont", "blockquote", "body", "caption", "center", "col",
  "colgroup", "dd", "details", "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure",
  "footer", "form", "frame", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hr",
  "html", "iframe", "legend", "li", "link", "main", "menu", "menuitem", "nav", "noframes", "ol",
  "optgroup", "option", "p", "param", "search", "section", "summary", "table", "tbody", "td", "tfoot",
  "th", "thead", "title", "tr", "track", "ul",
].join("|");
const HTML_TAG_NAME = "[A-Za-z][A-Za-z0-9-]*";
const HTML_ATTRIBUTE_NAME = "[A-Za-z_:][A-Za-z0-9_.:-]*";
const HTML_ATTRIBUTE_VALUE = "(?:[^ \\t\\r\\n\"'=<>`]+|'[^']*'|\"[^\"]*\")";
const HTML_ATTRIBUTE = `(?:[ \\t]+${HTML_ATTRIBUTE_NAME}(?:[ \\t]*=[ \\t]*${HTML_ATTRIBUTE_VALUE})?)*`;
const COMPLETE_HTML_TAG = new RegExp(
  `^ {0,3}(?:<${HTML_TAG_NAME}${HTML_ATTRIBUTE}[ \\t]*/?>|</${HTML_TAG_NAME}[ \\t]*>)[ \\t]*$`,
);
const HTML_BLOCK_TAG = new RegExp(`^ {0,3}</?(?:${HTML_BLOCK_TAGS})(?:[ \\t]|/?>|$)`, "i");

function htmlBlockStart(line, paragraphOpen) {
  if (/^ {0,3}<(?:pre|script|style|textarea)(?:[ \t]|>|$)/i.test(line)) {
    return { end: /<\/(?:pre|script|style|textarea)>/i };
  }
  if (/^ {0,3}<!--/.test(line)) return { end: /-->/ };
  if (/^ {0,3}<\?/.test(line)) return { end: /\?>/ };
  if (/^ {0,3}<![A-Za-z]/.test(line)) return { end: />/ };
  if (/^ {0,3}<!\[CDATA\[/.test(line)) return { end: /\]\]>/ };
  if (HTML_BLOCK_TAG.test(line)) return { end: null };
  if (paragraphOpen || !COMPLETE_HTML_TAG.test(line)) return null;
  return { end: null };
}

function tableCells(line) {
  const cells = [];
  let start = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "|" && !isEscaped(line, index)) {
      cells.push(line.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (cells.length === 0) return null;
  cells.push(line.slice(start).trim());
  if (cells[0] === "") cells.shift();
  if (cells.at(-1) === "") cells.pop();
  return cells;
}

function inlineHtmlCloses(lines, from, quotes, base) {
  for (let index = from + 1; index < lines.length; index += 1) {
    let body = lineBody(lines[index]);
    for (let quote = 0; quote < quotes; quote += 1) {
      const prefix = /^ {0,3}>[ \t]?/.exec(body);
      if (!prefix) return false;
      body = body.slice(prefix[0].length);
    }
    if (body.trim() === "" || /^ {0,3}>/.test(body)) return false;
    if (/^ */.exec(body)[0].length < base) return false;
    body = body.slice(base);
    if (openingFence(body) || htmlBlockStart(body, true)
      || /^ {0,3}(?:=+|-+)[ \t]*$/.test(body)
      || /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(body)
      || /^ {0,3}(?:\$\$|#{1,6}(?:[ \t]|$)|[-+*][ \t]|1[.)][ \t])/.test(body)) return false;
    if (body.includes("-->")) return true;
  }
  return false;
}

// Project Markdown containers only for reads. Source-edit offsets always use the original note.
function projectMarkdown(source) {
  const lines = splitLines(source);
  const containers = [];
  const yamlEnd = frontmatterEnd(lines);
  let listIndents = [];
  let quoteDepth = 0;
  let fence = null;
  let html = null;
  let math = null;
  let table = false;
  let previousLine = "";
  let commentScope = null;
  let paragraphOpen = false;
  let definitionIndent = null;
  let commentKind = null;
  for (let index = yamlEnd; index < lines.length; index += 1) {
    const raw = lines[index];
    const ending = raw.slice(lineBody(raw).length);
    let body = lineBody(raw);
    let quotes = 0;
    const block = fence || html || math;
    while (quotes < (block ? block.quotes : Infinity)) {
      const match = /^ {0,3}>[ \t]?/.exec(body);
      if (!match) break;
      body = body.slice(match[0].length);
      quotes += 1;
    }
    if (!block && quotes !== quoteDepth) {
      listIndents = [];
      definitionIndent = null;
      paragraphOpen = false;
      table = false;
      previousLine = "";
      if (commentKind === "html") commentKind = null;
    }
    quoteDepth = quotes;
    const originalBody = body;
    body = body.replace(/^[ \t]+/, (indent) => {
      let width = 0;
      for (const character of indent) width += character === "\t" ? 4 - width % 4 : 1;
      return " ".repeat(width);
    });
    const indent = /^ */.exec(body)[0].length;
    if (!block && body.trim()) {
      while (listIndents.length && indent < listIndents.at(-1).indent) listIndents.pop();
    }
    let base = block?.base ?? definitionIndent ?? listIndents.at(-1)?.indent ?? 0;
    const compatible = quotes === (block?.quotes ?? quotes) && (indent >= base || body.trim() === "");
    if (block && !compatible) {
      // A code/HTML block ends with its container, even without an explicit closer.
      fence = null;
      html = null;
      math = null;
      table = false;
      if (quotes !== block.quotes) listIndents = [];
      paragraphOpen = false;
      definitionIndent = null;
      index -= 1;
      continue;
    }
    let text = base === 0 ? originalBody : body.slice(Math.min(base, indent));
    if (commentKind === "html" && (!text.trim()
      || commentScope !== `${quotes}:${base}:${listIndents.map((entry) => entry.id).join(",")}`)) commentKind = null;
    if (!block && definitionIndent !== null && text.trim() && !continuationIndent(text, false) && !definitionStart(text)) definitionIndent = null;
    if (!block && definitionIndent === null && !commentKind) {
      let marker;
      while ((marker = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+|$)/.exec(text))) {
        if (/^ {0,3}(?:[-*][ \t]*){3,}$/.test(text)) break;
        if (paragraphOpen && ((/^\d/.test(marker[2]) && Number.parseInt(marker[2], 10) !== 1)
          || !text.slice(marker[0].length).trim())) break;
        const markerWidth = marker[1].length + marker[2].length;
        let paddingWidth = 0;
        for (const character of marker[3]) {
          paddingWidth += character === "\t" ? 4 - (base + markerWidth + paddingWidth) % 4 : 1;
        }
        base += markerWidth + (paddingWidth <= 4 ? paddingWidth || 1 : 1);
        listIndents.push({ indent: base, id: `${index}:${listIndents.length}` });
        text = (paddingWidth > 4 ? " ".repeat(paddingWidth - 1) : "") + text.slice(marker[0].length);
        paragraphOpen = false;
        table = false;
        previousLine = "";
      }
    }
    const metadata = { signature: `${quotes}:${base}:${listIndents.map((entry) => entry.id).join(",")}`, contained: quotes > 0 || base > 0, visible: "", open: null, paragraphOpen };
    containers[index] = metadata;
    lines[index] = text + ending;
    if (fence) {
      if (isClosingFence(text, fence)) fence = null;
      continue;
    }
    const mathOpener = !math && !html && !commentKind && /^ {0,3}\$\$/.test(text);
    if (math || mathOpener) {
      if (!math) math = { quotes, base };
      if (findUnescaped(text, "$$", mathOpener ? text.indexOf("$$") + 2 : 0) >= 0) math = null;
      paragraphOpen = false;
      table = false;
      continue;
    }
    if (!html) {
      const openHtml = !commentKind && htmlBlockStart(text, paragraphOpen);
      if (openHtml) html = { ...openHtml, quotes, base };
    }
    if (html) {
      if (html.end ? html.end.test(text) : text.trim() === "") html = null;
      paragraphOpen = false;
      table = false;
      continue;
    }
    const inlineHtmlOpen = findUnescaped(text, "<!--", 0);
    const needsHtmlEnd = !commentKind && inlineHtmlOpen >= 0 && text.indexOf("-->", inlineHtmlOpen + 4) < 0;
    const masked = maskComments(text, commentKind, !needsHtmlEnd || inlineHtmlCloses(lines, index, quotes, base));
    commentKind = masked.commentKind;
    commentScope = commentKind === "html" ? metadata.signature : null;
    metadata.visible = masked.text;
    const open = openingFence(masked.text);
    if (open) {
      metadata.open = open;
      fence = { ...open, quotes, base };
      definitionIndent = null;
      paragraphOpen = false;
      table = false;
      continue;
    }
    const cells = tableCells(masked.text);
    const header = tableCells(previousLine);
    if (paragraphOpen && cells && header && cells.length === header.length
      && cells.every((cell) => /^:?-+:?$/.test(cell))) table = true;
    if (!masked.text.trim() || !cells) table = false;
    metadata.table = table;
    if (!table && definitionStart(masked.text)) definitionIndent = base;
    else if (text.trim() && !continuationIndent(text, false)) definitionIndent = null;
    if (table
      || !masked.text.trim()
      || definitionStart(masked.text)
      || /^ {0,3}#{1,6}(?:[ \t]|$)/.test(masked.text)
      || /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(masked.text)
      || (paragraphOpen && /^ {0,3}(?:=+|-+)[ \t]*$/.test(masked.text))) paragraphOpen = false;
    else if (!/^(?: {4}|\t)/.test(masked.text)) paragraphOpen = true;
    previousLine = masked.text;

  }
  return { lines, containers };
}

function fencedBlock(projected, from) {
  const { lines, containers } = projected;
  const start = containers[from];
  if (!start?.open) return null;
  let end = from + 1;
  while (end < lines.length && containers[end]?.signature === start.signature) {
    if (isClosingFence(lineBody(lines[end]), start.open)) break;
    end += 1;
  }
  const closed = end < lines.length && containers[end]?.signature === start.signature;
  const indent = /^ */.exec(lineBody(lines[from]))[0].length;
  const body = lines.slice(from + 1, end).map((line) => line.replace(new RegExp(`^ {0,${indent}}`), "")).join("");
  return {
    ...start.open, body, contained: start.contained,
    lineStart: from, lineEnd: closed ? end : Math.max(from, end - 1),
    next: closed ? end + 1 : end,
  };
}

function footnoteLayoutFences(source, offset = 0, depth = 0) {
  if (depth > MAX_NESTING_DEPTH) return [];
  const projected = projectMarkdown(source);
  const found = [];
  for (let index = 0; index < projected.lines.length;) {
    const block = fencedBlock(projected, index);
    if (!block) { index += 1; continue; }
    if (LAYOUT_LANGUAGES.has(block.language)) {
      found.push({ ...block, lineStart: offset + block.lineStart, lineEnd: offset + block.lineEnd });
      found.push(...footnoteLayoutFences(block.body, offset + block.lineStart + 1, depth + 1));
    }
    index = block.next;
  }
  return found;
}

function collectDefinitions(source, includeLayouts, depth = 0) {
  const projected = projectMarkdown(typeof source === "string" ? source : "");
  const { lines, containers } = projected;
  const definitions = new Map();
  for (let index = 0; index < lines.length;) {
    const block = fencedBlock(projected, index);
    if (block) {
      if (includeLayouts && LAYOUT_LANGUAGES.has(block.language) && depth < MAX_NESTING_DEPTH) {
        for (const [id, raw] of collectDefinitions(block.body, includeLayouts, depth + 1)) definitions.set(id, raw);
      }
      index = block.next;
      continue;
    }
    const definition = !containers[index]?.table && definitionStart(containers[index]?.visible ?? "");
    if (!definition) { index += 1; continue; }
    let limit = index + 1;
    while (limit < lines.length && containers[limit]?.signature === containers[index].signature) limit += 1;
    const end = definitionEnd(lines, index, limit);
    definitions.set(definition.id, lines.slice(index, end).join(""));
    index = Math.max(index + 1, end);
  }
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

function lineHasFootnoteReference(line, inTable = false) {
  const visible = maskInlineCode(line);
  const pattern = /\[\^([^\]\r\n]+)\]/g;
  let match;
  while ((match = pattern.exec(visible))) {
    if (isEscaped(visible, match.index)) continue;
    if (visible[match.index - 1] === "!" && !isEscaped(visible, match.index - 1)) continue;
    if (!inTable
      && visible[pattern.lastIndex] === ":"
      && /^ {0,3}$/.test(visible.slice(0, match.index))) continue;
    if (normalizeFootnoteId(match[1])) return true;
  }
  return false;
}

function hasFootnoteReferences(markdown) {
  const projected = projectMarkdown(typeof markdown === "string" ? markdown : "");
  for (let index = 0; index < projected.lines.length;) {
    const block = fencedBlock(projected, index);
    if (block) { index = block.next; continue; }
    const visible = projected.containers[index]?.visible ?? "";
    if ((projected.containers[index]?.paragraphOpen || !/^(?: {4}|\t)/.test(visible))
      && lineHasFootnoteReference(visible, projected.containers[index]?.table === true)) return true;
    index += 1;
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
