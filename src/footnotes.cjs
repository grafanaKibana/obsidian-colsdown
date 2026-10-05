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
    if (close < 0) {
      cursor = open + length;
      continue;
    }
    output = output.slice(0, open) + " ".repeat(close + length - open) + output.slice(close + length);
    cursor = close + length;
  }
  return output;
}

function linkDefinitionStart(line) {
  const match = /^ {0,3}\[((?:\\.|[^\\\]])+)\]:[ \t]*/.exec(line);
  return match && match[1][0] !== "^" ? match : null;
}

function maskLinkDestinations(line, includeDefinitions = true, definitionLine = line) {
  let output = line;
  let openTitle = "";
  let definitionPrefix = false;
  let definitionComplete = false;
  let definitionHasTitle = false;
  const mask = (start, end) => {
    output = output.slice(0, start) + " ".repeat(end - start) + output.slice(end);
  };
  const destination = (start, source = line) => {
    if (source[start] === "<") {
      const close = findUnescaped(source, ">", start + 1);
      if (close < 0 || /\s/.test(source.slice(start + 1, close))) return null;
      return { end: close + 1, boundary: source[close + 1] ?? "" };
    }
    let depth = 0;
    for (let cursor = start; cursor < source.length; cursor += 1) {
      const character = source[cursor];
      if (/\s/.test(character)) {
        return depth === 0 ? { end: cursor, boundary: " " } : null;
      }
      if (isEscaped(source, cursor)) continue;
      if (character === "(") depth += 1;
      else if (character === ")") {
        if (depth === 0) return { end: cursor, boundary: ")" };
        depth -= 1;
      } else if (character === "<") return null;
    }
    return depth === 0 ? { end: source.length, boundary: "" } : null;
  };
  const inlineClose = (start) => {
    const parsed = destination(start);
    if (!parsed) return -1;
    if (parsed.boundary === ")") return parsed.end;
    if (parsed.boundary !== " ") return -1;
    let cursor = parsed.end;
    while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;
    if (line[cursor] === ")") return cursor;
    const opener = line[cursor];
    const closer = opener === "(" ? ")" : opener === "\"" || opener === "'" ? opener : "";
    if (!closer) return -1;
    const titleEnd = findUnescaped(line, closer, cursor + 1);
    if (titleEnd < 0) return -1;
    cursor = titleEnd + 1;
    while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;
    return line[cursor] === ")" ? cursor : -1;
  };

  const definition = includeDefinitions ? linkDefinitionStart(definitionLine) : null;
  if (definition) {
    const start = definition[0].length;
    const parsed = destination(start, definitionLine);
    definitionPrefix = start === definitionLine.length;
    if (parsed && parsed.end > start && parsed.boundary !== ")") {
      let end = parsed.end;
      if (parsed.boundary === "") definitionComplete = true;
      else if (parsed.boundary === " ") {
        let cursor = end;
        while (definitionLine[cursor] === " " || definitionLine[cursor] === "\t") cursor += 1;
        if (cursor === definitionLine.length) definitionComplete = true;
        else {
          const opener = definitionLine[cursor];
          const closer = opener === "(" ? ")" : opener === "\"" || opener === "'" ? opener : "";
          if (closer) {
            const titleEnd = findUnescaped(definitionLine, closer, cursor + 1);
            if (titleEnd >= 0 && !definitionLine.slice(titleEnd + 1).trim()) {
              end = definitionLine.length;
              definitionComplete = true;
              definitionHasTitle = true;
            } else if (titleEnd < 0) openTitle = closer;
          }
        }
      }
      mask(start, end);
    }
  }

  for (let cursor = 0; cursor < line.length;) {
    const open = findUnescaped(line, "[[", cursor);
    if (open < 0) break;
    const close = findUnescaped(line, "]]", open + 2);
    if (close < 0) break;
    mask(open + 2, close);
    cursor = close + 2;
  }

  const brackets = [];
  for (let cursor = 0; cursor < line.length; cursor += 1) {
    if (isEscaped(line, cursor)) continue;
    if (line[cursor] === "[") {
      brackets.push(cursor);
      continue;
    }
    if (line[cursor] !== "]" || brackets.length === 0) continue;
    brackets.pop();
    if (line[cursor + 1] !== "(") continue;
    let start = cursor + 2;
    while (line[start] === " " || line[start] === "\t") start += 1;
    const end = inlineClose(start);
    if (end >= start) {
      mask(start, end);
      cursor = end;
    }
  }

  const autolink = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*>/g;
  let match;
  while ((match = autolink.exec(line))) {
    if (!isEscaped(line, match.index)) mask(match.index + 1, autolink.lastIndex - 1);
  }
  return { text: output, openTitle, definitionPrefix, definitionComplete, definitionHasTitle };
}

function inlineCodeClose(line, length, from) {
  const marker = "`".repeat(length);
  let close = line.indexOf(marker, from);
  while (close >= 0) {
    if (line[close - 1] !== "`" && line[close + length] !== "`") return close;
    close = line.indexOf(marker, close + length);
  }
  return -1;
}

function inlineCodeBoundary(metadata) {
  const line = metadata?.inline ?? metadata?.visible ?? "";
  return !line.trim()
    || metadata.open
    || metadata.table
    || /^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)
    || /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,}|=+)[ \t]*$/.test(line)
    || (!metadata.paragraphOpen && /^(?: {4}|\t)/.test(line));
}

function maskInlineCodeSpans(containers) {
  for (const metadata of containers) {
    if (metadata && metadata.inline !== null) metadata.code = metadata.inline;
  }

  function mask(metadata, from, to) {
    const spaces = " ".repeat(to - from);
    metadata.visible = metadata.visible.slice(0, from) + spaces + metadata.visible.slice(to);
    metadata.code = metadata.code.slice(0, from) + spaces + metadata.code.slice(to);
  }

  for (let index = 0; index < containers.length; index += 1) {
    const start = containers[index];
    const startText = start?.inline ?? start?.visible ?? "";
    if (!start?.visible) continue;
    let cursor = 0;
    while (cursor < start.visible.length) {
      const open = start.visible.indexOf("`", cursor);
      if (open < 0) break;
      if (isEscaped(startText, open)) {
        cursor = open + 1;
        continue;
      }
      let length = 1;
      while (startText[open + length] === "`") length += 1;
      let closeLine = index;
      let close = inlineCodeClose(startText, length, open + length);
      if (close < 0 && inlineCodeBoundary(start)) {
        cursor = open + length;
        continue;
      }
      while (close < 0 && closeLine + 1 < containers.length) {
        const next = containers[closeLine + 1];
        if (next?.signature !== start.signature || inlineCodeBoundary(next)) break;
        closeLine += 1;
        close = inlineCodeClose(next.inline ?? next.visible ?? "", length, 0);
      }
      if (close < 0) {
        cursor = open + length;
        continue;
      }
      if (closeLine === index) {
        mask(start, open, close + length);
        cursor = close + length;
        continue;
      }
      mask(start, open, start.visible.length);
      for (let masked = index + 1; masked < closeLine; masked += 1) {
        mask(containers[masked], 0, containers[masked].visible.length);
      }
      const end = containers[closeLine];
      mask(end, 0, close + length);
      break;
    }
  }
}

function projectedHtmlCommentCloses(containers, from, open) {
  const start = containers[from];
  if (start.code.indexOf("-->", open + 4) >= 0) return true;
  for (let index = from + 1; index < containers.length; index += 1) {
    const next = containers[index];
    const line = next?.code ?? "";
    if (next?.signature !== start.signature
      || next.inline === null
      || !line.trim()
      || openingFence(line)
      || htmlBlockStart(line, true)
      || /^ {0,3}(?:=+|-+|\$\$)[ \t]*$/.test(line)
      || /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,}|#{1,6}(?:[ \t]|$)|[-+*][ \t]|1[.)][ \t])/.test(line)) return false;
    if (line.includes("-->")) return true;
  }
  return false;
}

function maskProjectedComments(containers) {
  let commentKind = null;
  let commentScope = null;
  for (let index = 0; index < containers.length; index += 1) {
    const metadata = containers[index];
    if (!metadata) continue;
    if (metadata?.inline === null) {
      if (commentKind === "html") commentKind = null;
      continue;
    }
    if (commentKind === "html" && (commentScope !== metadata.signature || !metadata.code.trim())) commentKind = null;
    const htmlOpen = commentKind ? -1 : findUnescaped(metadata.code, "<!--", 0);
    const inlineHtmlCloses = htmlOpen < 0 || projectedHtmlCommentCloses(containers, index, htmlOpen);
    const masked = maskComments(metadata.code, commentKind, inlineHtmlCloses);
    metadata.visible = masked.text;
    metadata.open = openingFence(masked.text);
    commentKind = masked.commentKind;
    commentScope = commentKind === "html" ? metadata.signature : null;
  }
}

function inlineCodeMasks(containers) {
  const masks = Array.from({ length: containers.length }, () => []);
  for (let line = 0; line < containers.length; line += 1) {
    const metadata = containers[line];
    if (!metadata?.inline || !metadata.code) continue;
    const ranges = [];
    let start = null;
    for (let index = 0; index <= metadata.inline.length; index += 1) {
      const masked = index < metadata.inline.length
        && metadata.code[index] === " "
        && metadata.inline[index] !== " ";
      if (masked && start === null) start = index;
      else if (!masked && start !== null) {
        ranges.push({ from: start, to: index });
        start = null;
      }
    }
    masks[line] = ranges;
  }
  return masks;
}

function applyInlineCodeMasks(line, masks) {
  let output = line;
  for (const { from, to } of masks ?? []) {
    if (from >= output.length) continue;
    const end = Math.min(to, output.length);
    output = output.slice(0, from) + " ".repeat(end - from) + output.slice(end);
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
const INLINE_HTML_SPACE = "[ \\t]*(?:\\n[ \\t]*)?";
const INLINE_HTML_ATTRIBUTE_SPACE = "(?:[ \\t]+|[ \\t]*\\n[ \\t]*)";
const INLINE_HTML_ATTRIBUTE_VALUE = "(?:[^ \\t\\r\\n\"'=<>`]+|'[^']*'|\"[^\"]*\")";
const INLINE_HTML_ATTRIBUTE = `${INLINE_HTML_ATTRIBUTE_SPACE}${HTML_ATTRIBUTE_NAME}(?:${INLINE_HTML_SPACE}=${INLINE_HTML_SPACE}${INLINE_HTML_ATTRIBUTE_VALUE})?`;
const INLINE_HTML_TAG_SOURCE = `(?:<${HTML_TAG_NAME}(?:${INLINE_HTML_ATTRIBUTE})*${INLINE_HTML_SPACE}/?>|</${HTML_TAG_NAME}${INLINE_HTML_SPACE}>)`;
const INLINE_HTML_TAG = new RegExp(INLINE_HTML_TAG_SOURCE, "g");
const INLINE_HTML_TAG_START = new RegExp(`^${INLINE_HTML_TAG_SOURCE}`);
const COMPLETE_HTML_TAG = new RegExp(
  `^ {0,3}(?:<${HTML_TAG_NAME}${HTML_ATTRIBUTE}[ \\t]*/?>|</${HTML_TAG_NAME}[ \\t]*>)[ \\t]*$`,
);
const HTML_BLOCK_TAG = new RegExp(`^ {0,3}</?(?:${HTML_BLOCK_TAGS})(?:[ \\t]|/?>|$)`, "i");

function maskInlineHtmlTags(line, initialCommentKind) {
  let output = line;
  let commentKind = initialCommentKind;
  let cursor = 0;
  INLINE_HTML_TAG.lastIndex = 0;
  let match;
  while ((match = INLINE_HTML_TAG.exec(line))) {
    if (isEscaped(line, match.index)) continue;
    while (cursor < match.index) {
      if (commentKind) {
        const token = commentKind === "html" ? "-->" : "%%";
        const close = commentKind === "html"
          ? line.indexOf(token, cursor)
          : findUnescaped(line, token, cursor);
        if (close < 0 || close >= match.index) break;
        cursor = close + token.length;
        commentKind = null;
        continue;
      }
      const htmlOpen = findUnescaped(line, "<!--", cursor);
      const obsidianOpen = findUnescaped(line, "%%", cursor);
      const open = htmlOpen < 0 ? obsidianOpen
        : obsidianOpen < 0 ? htmlOpen
          : Math.min(htmlOpen, obsidianOpen);
      if (open < 0 || open >= match.index) break;
      cursor = open + (open === htmlOpen ? 4 : 2);
      commentKind = open === htmlOpen ? "html" : "obsidian";
    }
    if (commentKind) continue;
    output = output.slice(0, match.index) + " ".repeat(match[0].length) + output.slice(INLINE_HTML_TAG.lastIndex);
    cursor = INLINE_HTML_TAG.lastIndex;
  }
  return output;
}

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

function multilineLinkMetadataMasks(lines, containers) {
  const masks = Array.from({ length: lines.length }, () => []);
  for (let index = 0; index < lines.length; index += 1) {
    const firstLine = lineBody(lines[index] ?? "");
    const definition = linkDefinitionStart(firstLine);
    if (!definition || containers[index]?.paragraphOpen) continue;
    const signature = containers[index]?.signature;
    let joined = firstLine;
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      const state = maskLinkDestinations(joined, true, joined);
      if (state.definitionComplete) {
        if (state.definitionHasTitle && cursor > index) {
          const titleSource = lines.slice(index, cursor + 1).map(lineBody).join("\n");
          if (/%%|<!--/.test(titleSource)) {
            masks[index].push({ from: definition[0].length, to: firstLine.length });
            for (let masked = index + 1; masked <= cursor; masked += 1) {
              masks[masked].push({ from: 0, to: lineBody(lines[masked]).length });
            }
          }
        }
        break;
      }
      if (!state.definitionPrefix && !state.openTitle) break;
      const next = containers[cursor + 1];
      if (!next
        || next.signature !== signature
        || next.inline === null
        || inlineCodeBoundary(next)) break;
      joined += ` ${lineBody(lines[cursor + 1]).trimStart()}`;
    }
  }
  return masks;
}

function multilineInlineHtmlMasks(lines, containers) {
  const masks = Array.from({ length: lines.length }, () => []);
  for (let index = 0; index < containers.length; index += 1) {
    const start = containers[index];
    const first = start?.code ?? start?.inline ?? "";
    for (let open = first.indexOf("<"); open >= 0; open = first.indexOf("<", open + 1)) {
      if (isEscaped(first, open) || start.visible?.[open] !== "<") continue;
      let joined = first.slice(open);
      let cursor = index;
      while (cursor + 1 < containers.length && !INLINE_HTML_TAG_START.test(joined)) {
        const next = containers[cursor + 1];
        if (next?.signature !== start.signature || next.inline === null || inlineCodeBoundary(next)) break;
        cursor += 1;
        joined += `\n${next.code ?? next.inline ?? ""}`;
      }
      const tag = INLINE_HTML_TAG_START.exec(joined)?.[0];
      if (!tag || !tag.includes("\n") || !/%%|<!--/.test(tag)) continue;
      const parts = tag.split("\n");
      masks[index].push({ from: open, to: open + parts[0].length });
      for (let part = 1; part < parts.length; part += 1) {
        masks[index + part].push({ from: 0, to: parts[part].length });
      }
      open += parts[0].length - 1;
    }
  }
  return masks;
}

// Project Markdown containers only for reads. Source-edit offsets always use the original note.
function projectMarkdown(source, codeMasks = null) {
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
    const parsedText = applyInlineCodeMasks(text, codeMasks?.[index]);
    const linkMetadataText = maskLinkDestinations(parsedText, !paragraphOpen, text).text;
    const metadataText = maskInlineHtmlTags(linkMetadataText, commentKind);
    const metadata = { signature: `${quotes}:${base}:${listIndents.map((entry) => entry.id).join(",")}`, contained: quotes > 0 || base > 0, inline: null, visible: "", open: null, paragraphOpen };
    containers[index] = metadata;
    lines[index] = text + ending;
    if (fence) {
      if (isClosingFence(text, fence)) fence = null;
      continue;
    }
    const mathOpener = !math && !html && !commentKind && /^ {0,3}\$\$/.test(parsedText);
    if (math || mathOpener) {
      if (!math) math = { quotes, base };
      if (findUnescaped(parsedText, "$$", mathOpener ? parsedText.indexOf("$$") + 2 : 0) >= 0) math = null;
      paragraphOpen = false;
      table = false;
      continue;
    }
    if (!html) {
      const openHtml = !commentKind && htmlBlockStart(parsedText, paragraphOpen);
      if (openHtml) html = { ...openHtml, quotes, base };
    }
    if (html) {
      if (html.end ? html.end.test(parsedText) : parsedText.trim() === "") html = null;
      paragraphOpen = false;
      table = false;
      continue;
    }
    const inlineHtmlOpen = findUnescaped(metadataText, "<!--", 0);
    const needsHtmlEnd = !commentKind && inlineHtmlOpen >= 0 && metadataText.indexOf("-->", inlineHtmlOpen + 4) < 0;
    const masked = maskComments(metadataText, commentKind, !needsHtmlEnd || inlineHtmlCloses(lines, index, quotes, base));
    metadata.inline = metadataText;
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
  maskInlineCodeSpans(containers);
  maskProjectedComments(containers);
  if (codeMasks === null) {
    const masks = inlineCodeMasks(containers);
    const linkMasks = multilineLinkMetadataMasks(lines, containers);
    const htmlMasks = multilineInlineHtmlMasks(lines, containers);
    for (let index = 0; index < masks.length; index += 1) {
      masks[index].push(...linkMasks[index], ...htmlMasks[index]);
    }
    const masksCommentOpener = masks.some((ranges, index) => ranges.some(({ from, to }) => (
      /%%|<!--/.test(lineBody(lines[index] ?? "").slice(from, to))
    )));
    if (masksCommentOpener) return projectMarkdown(source, masks);
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
    if (!block) {
      const start = projected.containers[index];
      if (!start?.table && definitionStart(start?.visible ?? "") && definitionStart(lineBody(projected.lines[index]))) {
        let limit = index + 1;
        while (limit < projected.lines.length && projected.containers[limit]?.signature === start.signature) limit += 1;
        const end = definitionEnd(projected.lines, index, limit);
        const body = projected.lines.slice(index + 1, end).map((line) => line.replace(/^(?: {4}|\t)/, "")).join("");
        found.push(...footnoteLayoutFences(body, offset + index + 1, depth + 1).map((candidate) => ({ ...candidate, contained: true, inDefinition: true })));
        index = end;
      } else index += 1;
      continue;
    }
    if (LAYOUT_LANGUAGES.has(block.language)) {
      found.push({ ...block, depth, lineStart: offset + block.lineStart, lineEnd: offset + block.lineEnd });
      found.push(...footnoteLayoutFences(block.body, offset + block.lineStart + 1, depth + 1));
    }
    index = block.next;
  }
  return found;
}

function mapFootnoteLayouts(previousSnapshot, snapshot) {
  const previous = footnoteLayoutFences(previousSnapshot);
  const current = footnoteLayoutFences(snapshot);
  if (previous.length !== current.length || previous.some((candidate, index) => {
    const updated = current[index];
    return candidate.language !== updated.language
      || candidate.character !== updated.character
      || candidate.length !== updated.length
      || candidate.depth !== updated.depth
      || Boolean(candidate.contained) !== Boolean(updated.contained)
      || Boolean(candidate.inDefinition) !== Boolean(updated.inDefinition);
  })) return [];
  return previous.map((candidate, index) => ({
    language: candidate.language,
    previousLocation: { lineStart: candidate.lineStart, lineEnd: candidate.lineEnd },
    location: { lineStart: current[index].lineStart, lineEnd: current[index].lineEnd },
    previousSource: candidate.body,
    source: current[index].body,
  }));
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
    const definition = !containers[index]?.table && definitionStart(lineBody(lines[index]))
      && definitionStart(containers[index]?.visible ?? "");
    if (!definition) { index += 1; continue; }
    let limit = index + 1;
    while (limit < lines.length && containers[limit]?.signature === containers[index].signature) limit += 1;
    const end = definitionEnd(lines, index, limit);
    definitions.set(definition.id, lines.slice(index, end).join(""));
    if (includeLayouts && depth < MAX_NESTING_DEPTH) {
      const body = lines.slice(index + 1, end).map((line) => line.replace(/^(?: {4}|\t)/, "")).join("");
      for (const [id, raw] of collectDefinitions(body, includeLayouts, depth + 1)) definitions.set(id, raw);
    }
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

function lineHasFootnoteReference(line, inTable = false, originalLine = line, includeDefinitions = true) {
  const maskDefinitions = includeDefinitions && Boolean(linkDefinitionStart(originalLine));
  const visible = maskLinkDestinations(maskInlineCode(line), maskDefinitions, originalLine).text;
  const pattern = /\[\^([^\]\r\n]+)\]/g;
  let match;
  while ((match = pattern.exec(visible))) {
    if (isEscaped(visible, match.index)) continue;
    if (visible[match.index - 1] === "!" && !isEscaped(visible, match.index - 1)) continue;
    if (!inTable
      && visible[pattern.lastIndex] === ":"
      && /^ {0,3}$/.test(originalLine.slice(0, match.index))) continue;
    if (normalizeFootnoteId(match[1])) return true;
  }
  return false;
}

function multilineLinkDefinitionEnd(projected, index, line) {
  if (projected.containers[index]?.paragraphOpen
    || !linkDefinitionStart(lineBody(projected.lines[index] ?? ""))) return -1;
  const signature = projected.containers[index]?.signature;
  let joined = line;
  let definition = lineBody(projected.lines[index] ?? "");
  let lastComplete = -1;
  for (let cursor = index; cursor < projected.lines.length; cursor += 1) {
    const state = maskLinkDestinations(maskInlineCode(joined), true, definition);
    if (state.definitionComplete) {
      lastComplete = cursor;
      if (state.definitionHasTitle) return cursor;
    } else if (!state.definitionPrefix && !state.openTitle) return lastComplete;
    const next = projected.containers[cursor + 1];
    if (!next
      || next.signature !== signature
      || next.inline === null
      || inlineCodeBoundary(next)) return lastComplete;
    joined += ` ${next.visible.trimStart()}`;
    definition += ` ${lineBody(projected.lines[cursor + 1] ?? "").trimStart()}`;
  }
  return lastComplete;
}

function hasFootnoteReferences(markdown) {
  const projected = projectMarkdown(typeof markdown === "string" ? markdown : "");
  for (let index = 0; index < projected.lines.length;) {
    const block = fencedBlock(projected, index);
    if (block) { index = block.next; continue; }
    const visible = projected.containers[index]?.visible ?? "";
    const projectedLine = lineBody(projected.lines[index] ?? "");
    const definitionEnd = multilineLinkDefinitionEnd(projected, index, visible);
    if (definitionEnd >= 0) {
      index = definitionEnd + 1;
      continue;
    }
    if ((projected.containers[index]?.paragraphOpen || !/^(?: {4}|\t)/.test(projectedLine))
      && lineHasFootnoteReference(visible, projected.containers[index]?.table === true, projectedLine,
        !projected.containers[index]?.paragraphOpen)) return true;
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
        // Obsidian maps blocks in its generated footnotes section to a synthetic EOF line.
        const footnoteSection = sectionInfo.text === snapshot
          && sectionInfo.lineStart === splitLines(snapshot).length
          && sectionInfo.lineEnd === sectionInfo.lineStart;
        if (!mapped && !footnoteSection) return null;
        exact = candidates.filter((candidate) => (
          (footnoteSection && candidate.inDefinition)
          || (mapped && ((candidate.lineStart === mapped.lineStart && candidate.lineEnd === mapped.lineEnd)
            || (candidate.contained && candidate.lineStart >= mapped.lineStart && candidate.lineEnd <= mapped.lineEnd)))
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
  mapFootnoteLayouts,
  readFootnoteDefinitions,
};
