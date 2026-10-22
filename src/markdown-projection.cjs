// Shared read-only Markdown classification. Projected container prefixes may
// differ from the original source, so callers must keep source edit offsets raw.
const { splitLines, deindentSourceLine } = require("./layout.cjs");

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
  if (!match || match[1][0] === "^") return null;
  const label = match[1];
  if (findUnescaped(label, "[", 0) >= 0) return null;
  return match;
}

function containsReferenceDefinitionBracket(source) {
  return source.includes("[") || source.includes("]");
}

function linkDestination(source, start) {
  if (source[start] === "<") {
    const close = findUnescaped(source, ">", start + 1);
    if (close < 0 || /\s/.test(source.slice(start + 1, close))) return null;
    return { end: close + 1, boundary: source[close + 1] ?? "" };
  }
  let depth = 0;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (/\s/.test(character)) return depth === 0 ? { end: cursor, boundary: " " } : null;
    if (isEscaped(source, cursor)) continue;
    if (character === "(") depth += 1;
    else if (character === ")") {
      if (depth === 0) return { end: cursor, boundary: ")" };
      depth -= 1;
    } else if (character === "<") return null;
  }
  return depth === 0 ? { end: source.length, boundary: "" } : null;
}

function skipInlineLinkWhitespace(source, start) {
  let cursor = start;
  while (source[cursor] === " " || source[cursor] === "\t") cursor += 1;
  if (source[cursor] === "\n") {
    cursor += 1;
    while (source[cursor] === " " || source[cursor] === "\t") cursor += 1;
  }
  return cursor;
}

function inlineLinkClose(source, start) {
  const parsed = linkDestination(source, start);
  if (!parsed) return -1;
  if (parsed.boundary === ")") return parsed.end;
  if (parsed.boundary !== " ") return -1;
  let cursor = skipInlineLinkWhitespace(source, parsed.end);
  if (source[cursor] === ")") return cursor;
  const opener = source[cursor];
  const closer = opener === "(" ? ")" : opener === "\"" || opener === "'" ? opener : "";
  if (!closer) return -1;
  const titleEnd = findUnescaped(source, closer, cursor + 1);
  if (titleEnd < 0) return -1;
  cursor = skipInlineLinkWhitespace(source, titleEnd + 1);
  return source[cursor] === ")" ? cursor : -1;
}

function linkLabelPairs(line) {
  const brackets = [];
  const pairs = [];
  for (let cursor = 0; cursor < line.length; cursor += 1) {
    if (isEscaped(line, cursor)) continue;
    if (line[cursor] === "[") {
      brackets.push(cursor);
      continue;
    }
    if (line[cursor] !== "]" || brackets.length === 0) continue;
    const open = brackets.pop();
    pairs.push({ open, close: cursor });
  }
  return pairs;
}

function inlineLinkLabels(line) {
  return linkLabelPairs(line).filter(({ close }) => line[close + 1] === "(");
}

function normalizeReferenceLabel(label) {
  return label.replace(/\\(.)/g, "$1").trim().replace(/\s+/g, " ").toLowerCase();
}

function maskLinkDelimiterSources(line, initialCommentKind = null) {
  let output = maskInlineHtmlTags(line, initialCommentKind);
  for (let cursor = 0; cursor < line.length;) {
    const open = findUnescaped(line, "[[", cursor);
    if (open < 0) break;
    const close = findUnescaped(line, "]]", open + 2);
    if (close < 0) break;
    output = output.slice(0, open) + " ".repeat(close + 2 - open) + output.slice(close + 2);
    cursor = close + 2;
  }
  return output;
}

function maskLinkDestinations(line, includeDefinitions = true, definitionLine = line, initialCommentKind = null, referenceLabels = null) {
  let output = line;
  let openTitle = "";
  let definitionPrefix = false;
  let definitionComplete = false;
  let definitionHasTitle = false;
  const mask = (start, end) => {
    output = output.slice(0, start) + " ".repeat(end - start) + output.slice(end);
  };
  const maskLabelComments = (start, end) => {
    const label = line.slice(start, end);
    const searchable = maskInlineCode(maskInlineHtmlTags(label, null));
    let cursor = 0;
    while (cursor < label.length) {
      const htmlOpen = findUnescaped(searchable, "<!--", cursor);
      const obsidianOpen = findUnescaped(searchable, "%%", cursor);
      const open = htmlOpen < 0 ? obsidianOpen
        : obsidianOpen < 0 ? htmlOpen
          : Math.min(htmlOpen, obsidianOpen);
      if (open < 0) break;
      const isHtml = open === htmlOpen;
      const token = isHtml ? "-->" : "%%";
      const openLength = isHtml ? 4 : 2;
      const close = isHtml
        ? searchable.indexOf(token, open + openLength)
        : findUnescaped(searchable, token, open + openLength);
      const to = close < 0 ? open + openLength : close + token.length;
      mask(start + open, start + to);
      cursor = to;
    }
  };
  const definition = includeDefinitions ? linkDefinitionStart(definitionLine) : null;
  if (definition) {
    const start = definition[0].length;
    const parsed = linkDestination(definitionLine, start);
    definitionPrefix = start === definitionLine.length;
    const destination = parsed ? definitionLine.slice(start, parsed.end) : "";
    if (parsed && parsed.end > start && parsed.boundary !== ")" && !containsReferenceDefinitionBracket(destination)) {
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
      if (definitionComplete) {
        const labelOpen = definitionLine.indexOf("[");
        const labelClose = definition[0].lastIndexOf("]:");
        for (let opener = definitionLine.indexOf("<!--", labelOpen + 1);
          labelOpen >= 0 && opener >= 0 && opener < labelClose;
          opener = definitionLine.indexOf("<!--", opener + 4)) mask(opener, opener + 4);
      }
    }
  }

  for (let cursor = 0; cursor < line.length;) {
    const open = findUnescaped(line, "[[", cursor);
    if (open < 0) break;
    const close = findUnescaped(line, "]]", open + 2);
    if (close < 0) break;
    const commentText = maskInlineHtmlTags(output, initialCommentKind);
    const commentVisible = maskComments(commentText, initialCommentKind, false).text;
    if (commentVisible[open] !== commentText[open]) {
      cursor = close + 2;
      continue;
    }
    mask(open + 2, close);
    cursor = close + 2;
  }

  const delimiterText = line.includes("[") ? maskLinkDelimiterSources(line, initialCommentKind) : line;
  for (const label of linkLabelPairs(delimiterText)) {
    if (line[label.close + 1] === ":") continue;
    const commentText = maskInlineHtmlTags(output, initialCommentKind);
    const commentVisible = maskComments(commentText, initialCommentKind, false).text;
    if (commentVisible[label.open] !== commentText[label.open]) continue;
    maskLabelComments(label.open, label.close);
    if (referenceLabels?.size) {
      let referenceStart = label.open + 1;
      let referenceEnd = label.close;
      let metadataStart = -1;
      let metadataEnd = -1;
      if (line[label.close + 1] === "[") {
        const close = findUnescaped(line, "]", label.close + 2);
        if (close < 0) continue;
        metadataStart = label.close + 2;
        metadataEnd = close;
        if (metadataStart < metadataEnd) {
          referenceStart = metadataStart;
          referenceEnd = metadataEnd;
        }
      }
      if (!referenceLabels.has(normalizeReferenceLabel(line.slice(referenceStart, referenceEnd)))) continue;
      if (metadataStart >= 0) mask(metadataStart, metadataEnd);
    }
  }

  for (const link of inlineLinkLabels(delimiterText)) {
    const commentText = maskInlineHtmlTags(output, initialCommentKind);
    const commentVisible = maskComments(commentText, initialCommentKind, false).text;
    if (commentVisible[link.open] !== commentText[link.open]) continue;
    const start = skipInlineLinkWhitespace(line, link.close + 2);
    const end = inlineLinkClose(line, start);
    if (end >= start) {
      mask(start, end);
      maskLabelComments(link.open, link.close);
    }
  }

  const autolinks = [
    /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*>/g,
    /<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?>/g,
  ];
  for (const autolink of autolinks) {
    let match;
    while ((match = autolink.exec(line))) {
      if (isEscaped(line, match.index)) continue;
      const commentText = maskInlineHtmlTags(output, initialCommentKind);
      const commentVisible = maskComments(commentText, initialCommentKind, false).text;
      if (commentVisible[match.index] === commentText[match.index]) {
        mask(match.index + 1, autolink.lastIndex - 1);
      }
    }
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

function lazyParagraphContinuation(line, paragraphOpen) {
  return paragraphOpen
    && Boolean(line.trim())
    && !openingFence(line)
    && !htmlBlockStart(line, true)
    && !/^ {0,3}(?:\$\$|#{1,6}(?:[ \t]|$)|[-+*][ \t]|1[.)][ \t])/.test(line)
    && !/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,}|=+)[ \t]*$/.test(line);
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
  if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(start.code)) return false;
  for (let index = from + 1; index < containers.length; index += 1) {
    const next = containers[index];
    const line = next?.code ?? "";
    if (next?.signature !== start.signature
      || next.inline === null
      || !line.trim()
      || openingFence(line)
      || htmlBlockStart(line, true)
      || /^ {0,3}(?:=+|-+|\$\$)[ \t]*$/.test(line)
      || /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,}|#{1,6}(?:[ \t]|$)|[-+*](?:[ \t]|$)|1[.)](?:[ \t]|$))/.test(line)) return false;
    if (line.includes("-->")) return true;
  }
  return false;
}

function maskProjectedComments(containers, directive, persistentHtmlComments) {
  let commentKind = null;
  let commentScope = null;
  for (let index = 0; index < containers.length; index += 1) {
    const metadata = containers[index];
    if (!metadata) continue;
    if (metadata?.inline === null) {
      if (commentKind === "html") commentKind = null;
      continue;
    }
    if (commentKind === "html" && (commentScope !== metadata.signature || (!persistentHtmlComments && !metadata.code.trim()))) commentKind = null;
    const htmlOpen = commentKind ? -1 : findUnescaped(metadata.code, "<!--", 0);
    const inlineHtmlCloses = persistentHtmlComments || htmlOpen < 0 || projectedHtmlCommentCloses(containers, index, htmlOpen);
    const masked = !commentKind && metadata.directive && directive?.(metadata.code)
      ? { text: metadata.code, commentKind: null }
      : maskComments(metadata.code, commentKind, inlineHtmlCloses);
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

function inlineMathDelimiter(line, index, opening) {
  if (line[index] !== "$"
    || isEscaped(line, index)
    || (line[index - 1] === "$" && !isEscaped(line, index - 1))
    || (opening && line[index + 1] === "$")) return false;
  if (!opening && /\d/.test(line[index + 1] ?? "")) return false;
  const adjacent = line[opening ? index + 1 : index - 1];
  return Boolean(adjacent && !/\s/.test(adjacent));
}

function inlineMathOpenLength(line, index) {
  if (line[index] !== "$" || isEscaped(line, index)) return 0;
  if (line[index + 1] === "$"
    && line[index + 2] !== "$"
    && (line[index - 1] !== "$" || isEscaped(line, index - 1))) return 2;
  return inlineMathDelimiter(line, index, true) ? 1 : 0;
}

function inlineMathClose(line, from, length) {
  if (length === 2) {
    let close = line.indexOf("$$", from);
    while (close >= 0) {
      if (!isEscaped(line, close) && line[close - 1] !== "$" && line[close + 2] !== "$") return close;
      close = line.indexOf("$$", close + 2);
    }
    return -1;
  }
  let close = line.indexOf("$", from);
  while (close >= 0) {
    if (inlineMathDelimiter(line, close, false)) return close;
    close = line.indexOf("$", close + 1);
  }
  return -1;
}

function inlineMathMasks(containers) {
  const masks = Array.from({ length: containers.length }, () => []);
  const add = (line, from, to) => masks[line].push({ from, to });
  for (let line = 0; line < containers.length; line += 1) {
    const start = containers[line];
    const source = start?.code ?? "";
    let cursor = 0;
    while (cursor < source.length) {
      const open = source.indexOf("$", cursor);
      if (open < 0) break;
      const length = inlineMathOpenLength(source, open);
      if (start.visible?.[open] !== "$" || length === 0) {
        cursor = open + 1;
        continue;
      }
      let closeLine = line;
      let close = inlineMathClose(source, open + length, length);
      if (close < 0 && inlineCodeBoundary(start)) {
        cursor = open + 1;
        continue;
      }
      while (close < 0 && closeLine + 1 < containers.length) {
        const next = containers[closeLine + 1];
        if (next?.signature !== start.signature || next.inline === null || inlineCodeBoundary(next)) break;
        closeLine += 1;
        close = inlineMathClose(next.code ?? "", 0, length);
      }
      if (close < 0) {
        cursor = open + 1;
        continue;
      }
      if (closeLine === line) {
        add(line, open, close + length);
        cursor = close + length;
        continue;
      }
      add(line, open, source.length);
      for (let masked = line + 1; masked < closeLine; masked += 1) {
        add(masked, 0, containers[masked].code.length);
      }
      add(closeLine, 0, close + length);
      break;
    }
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
  const label = String(id);
  return /[ \t\r\n]/.test(label) ? "" : label.toLowerCase();
}

function definitionStart(line) {
  const match = /^ {0,3}\[\^([^\]\r\n]+)\]:/.exec(line);
  if (!match) return null;
  const id = normalizeFootnoteId(match[1]);
  return id ? { id, contentStart: match[0].length } : null;
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

function definitionBody(lines, from, to) {
  const first = lines[from];
  const start = definitionStart(lineBody(first)).contentStart;
  const content = first.slice(start).replace(/^[ \t]+/, (indent) => {
    let column = start;
    for (const character of indent) column += character === "\t" ? 4 - column % 4 : 1;
    const width = column - start;
    return " ".repeat(width >= 4 ? width - 4 : width);
  });
  return content + lines.slice(from + 1, to).map((line) => line.replace(/^(?: {4}|\t)/, "")).join("");
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
const INLINE_HTML_PROCESSING_SOURCE = "<\\?(?:[^?]|\\?(?!>))*\\?>";
const INLINE_HTML_DECLARATION_SOURCE = "<![A-Z][^>]*>";
const INLINE_HTML_CDATA_SOURCE = "<!\\[CDATA\\[(?:[^\\]]|\\](?!\\]>))*\\]\\]>";
const INLINE_HTML_RAW_SOURCE = `(?:${INLINE_HTML_TAG_SOURCE}|${INLINE_HTML_PROCESSING_SOURCE}|${INLINE_HTML_DECLARATION_SOURCE}|${INLINE_HTML_CDATA_SOURCE})`;
const INLINE_HTML_RAW = new RegExp(INLINE_HTML_RAW_SOURCE, "g");
const INLINE_HTML_RAW_START = new RegExp(`^${INLINE_HTML_RAW_SOURCE}`);
const COMPLETE_HTML_TAG = new RegExp(
  `^ {0,3}(?:<${HTML_TAG_NAME}${HTML_ATTRIBUTE}[ \\t]*/?>|</${HTML_TAG_NAME}[ \\t]*>)[ \\t]*$`,
);
const HTML_BLOCK_TAG = new RegExp(`^ {0,3}</?(?:${HTML_BLOCK_TAGS})(?:[ \\t]|/?>|$)`, "i");

function maskInlineHtmlTags(line, initialCommentKind) {
  let output = line;
  let commentKind = initialCommentKind;
  let cursor = 0;
  INLINE_HTML_RAW.lastIndex = 0;
  let match;
  while ((match = INLINE_HTML_RAW.exec(line))) {
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
    output = output.slice(0, match.index) + " ".repeat(match[0].length) + output.slice(INLINE_HTML_RAW.lastIndex);
    cursor = INLINE_HTML_RAW.lastIndex;
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
      || /^ {0,3}(?:\$\$|#{1,6}(?:[ \t]|$)|[-+*](?:[ \t]|$)|1[.)](?:[ \t]|$))/.test(body)) return false;
    if (body.includes("-->")) return true;
  }
  return false;
}

function multilineLinkMetadataMasks(lines, containers, referenceLabels = null) {
  const masks = Array.from({ length: lines.length }, () => []);
  const metadataBoundary = (metadata) => {
    const line = metadata?.code ?? metadata?.inline ?? "";
    return inlineCodeBoundary(metadata) || /^ {0,3}(?:[-+*][ \t]*|1[.)][ \t]*)$/.test(line);
  };
  const addDifferences = (fromLine, toLine, joined, maskedJoined) => {
    let offset = 0;
    for (let masked = fromLine; masked <= toLine; masked += 1) {
      const length = (containers[masked]?.code ?? containers[masked]?.inline ?? "").length;
      const sourceLine = joined.slice(offset, offset + length);
      const maskedLine = maskedJoined.slice(offset, offset + length);
      let from = null;
      for (let position = 0; position <= length; position += 1) {
        const hidden = position < length && sourceLine[position] !== maskedLine[position];
        if (hidden && from === null) from = position;
        else if (!hidden && from !== null) {
          masks[masked].push({ from, to: position });
          from = null;
        }
      }
      offset += length + 1;
    }
  };
  for (let index = 0; index < lines.length; index += 1) {
    const firstLine = lineBody(lines[index] ?? "");
    const definition = linkDefinitionStart(firstLine);
    if (!definition || containers[index]?.inline === null || containers[index]?.paragraphOpen) continue;
    const signature = containers[index]?.signature;
    let joined = firstLine;
    let lastComplete = -1;
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      const state = maskLinkDestinations(joined, true, joined);
      if (state.definitionComplete) {
        lastComplete = cursor;
        if (state.definitionHasTitle) break;
      } else if (!state.definitionPrefix && !state.openTitle) break;
      const next = containers[cursor + 1];
      if (!next
        || next.signature !== signature
        || next.inline === null
        || metadataBoundary(next)) break;
      joined += ` ${lineBody(lines[cursor + 1]).trimStart()}`;
    }
    if (lastComplete >= index) referenceLabels?.add(normalizeReferenceLabel(definition[1]));
    if (lastComplete > index) {
      const labelOpen = firstLine.indexOf("[");
      const labelClose = definition[0].lastIndexOf("]:");
      for (let opener = firstLine.indexOf("<!--", labelOpen + 1);
        labelOpen >= 0 && opener >= 0 && opener < labelClose;
        opener = firstLine.indexOf("<!--", opener + 4)) masks[index].push({ from: opener, to: opener + 4 });
      masks[index].push({ from: definition[0].length, to: firstLine.length });
      for (let masked = index + 1; masked <= lastComplete; masked += 1) {
        masks[masked].push({ from: 0, to: lineBody(lines[masked]).length });
      }
    }
  }
  for (let index = 0; index < containers.length; index += 1) {
    const start = containers[index];
    const first = start?.code ?? start?.inline ?? "";
    if (!first.includes("](")) continue;
    for (const link of inlineLinkLabels(maskLinkDelimiterSources(first))) {
      const open = link.close;
      if (start.visible?.[link.open] !== "[") continue;
      let joined = first;
      let cursor = index;
      let close = inlineLinkClose(joined, skipInlineLinkWhitespace(joined, open + 2));
      while (close < 0 && cursor + 1 < containers.length) {
        const next = containers[cursor + 1];
        if (next?.signature !== start.signature || next.inline === null || metadataBoundary(next)) break;
        cursor += 1;
        joined += `\n${next.code ?? next.inline ?? ""}`;
        close = inlineLinkClose(joined, skipInlineLinkWhitespace(joined, open + 2));
      }
      if (close < 0 || !joined.slice(open + 2, close).includes("\n")) continue;
      const maskedJoined = maskLinkDestinations(joined, false).text;
      addDifferences(index, cursor, joined, maskedJoined);
    }
  }
  for (let index = 0; index < containers.length;) {
    const start = containers[index];
    if (!start || start.inline === null || metadataBoundary(start)) {
      index += 1;
      continue;
    }
    const codeParts = [start.code ?? start.inline];
    const visibleParts = [start.visible];
    let hasLabelBracket = codeParts[0].includes("[");
    let cursor = index;
    while (cursor + 1 < containers.length) {
      const next = containers[cursor + 1];
      if (next?.signature !== start.signature || next.inline === null || metadataBoundary(next)) break;
      cursor += 1;
      const code = next.code ?? next.inline ?? "";
      codeParts.push(code);
      visibleParts.push(next.visible);
      if (code.includes("[")) hasLabelBracket = true;
    }
    if (hasLabelBracket) {
      const joined = codeParts.join("\n");
      if (!joined.includes("](")) {
        index = cursor + 1;
        continue;
      }
      const visibleJoined = visibleParts.join("\n");
      const complete = inlineLinkLabels(maskLinkDelimiterSources(joined)).some((link) => (
        joined.slice(link.open, link.close).includes("\n")
        && visibleJoined[link.open] === "["
        && inlineLinkClose(joined, skipInlineLinkWhitespace(joined, link.close + 2)) >= 0
      ));
      if (complete) addDifferences(index, cursor, joined, maskLinkDestinations(joined, false).text);
    }
    index = cursor + 1;
  }
  return masks;
}

function multilineInlineHtmlMasks(lines, containers) {
  const masks = Array.from({ length: lines.length }, () => []);
  let recovered = null;
  for (let index = 0; index < containers.length; index += 1) {
    let start = containers[index];
    let first = start?.code ?? start?.inline ?? "";
    let visible = start?.visible ?? "";
    if (recovered && start?.signature === recovered.signature && start.inline !== null && !inlineCodeBoundary(start)) {
      const masked = maskComments(maskInlineHtmlTags(first, recovered.commentKind), recovered.commentKind);
      visible = masked.text;
      recovered.commentKind = masked.commentKind;
    } else recovered = null;
    for (let open = first.indexOf("<"); open >= 0;) {
      if (isEscaped(first, open) || visible[open] !== "<") {
        open = first.indexOf("<", open + 1);
        continue;
      }
      let joined = first.slice(open);
      let cursor = index;
      while (cursor + 1 < containers.length && !INLINE_HTML_RAW_START.test(joined)) {
        const next = containers[cursor + 1];
        if (next?.signature !== start.signature || next.inline === null || inlineCodeBoundary(next)) break;
        cursor += 1;
        joined += `\n${next.code ?? next.inline ?? ""}`;
      }
      const tag = INLINE_HTML_RAW_START.exec(joined)?.[0];
      if (!tag || !tag.includes("\n")) {
        open = first.indexOf("<", open + 1);
        continue;
      }
      const parts = tag.split("\n");
      masks[index].push({ from: open, to: open + parts[0].length });
      for (let part = 1; part < parts.length; part += 1) {
        masks[index + part].push({ from: 0, to: parts[part].length });
      }
      // A completed tag makes its attribute comment delimiters literal. Continue
      // from its end with that corrected comment state, rather than requiring a
      // whole-document projection pass to discover each successive tag.
      index += parts.length - 1;
      start = containers[index];
      first = start.code ?? start.inline ?? "";
      const end = parts.at(-1).length;
      const suffix = maskComments(maskInlineHtmlTags(first.slice(end), null), null);
      visible = " ".repeat(end) + suffix.text;
      recovered = { signature: start.signature, commentKind: suffix.commentKind };
      open = first.indexOf("<", end);
    }
  }
  return masks;
}

// Project Markdown containers only for reads. Source-edit offsets always use the original note.
function projectMarkdownPass(source, codeMasks, referenceLabels, fragment, directive, persistentHtmlComments) {
  const lines = splitLines(source);
  const containers = Array.from({ length: lines.length }, () => null);
  const yamlEnd = fragment ? 0 : frontmatterEnd(lines);
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
    let lazyContainer = false;
    const block = fence || html || math;
    while (quotes < (block ? block.quotes : Infinity)) {
      const match = /^ {0,3}>[ \t]?/.exec(body);
      if (!match) break;
      body = body.slice(match[0].length);
      quotes += 1;
    }
    if (!block && quotes < quoteDepth && lazyParagraphContinuation(body, paragraphOpen)) {
      quotes = quoteDepth;
      lazyContainer = true;
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
      const lazyList = listIndents.length && indent < listIndents.at(-1).indent
        && lazyParagraphContinuation(body, paragraphOpen);
      if (lazyList) lazyContainer = true;
      if (!lazyList) while (listIndents.length && indent < listIndents.at(-1).indent) listIndents.pop();
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
    if (commentKind === "html" && ((!persistentHtmlComments && !text.trim())
      || commentScope !== `${quotes}:${base}:${listIndents.map((entry) => entry.id).join(",")}`)) commentKind = null;
    if (!block && definitionIndent !== null && text.trim() && !continuationIndent(text, false) && !definitionStart(text)) definitionIndent = null;
    if (!block && definitionIndent === null && !commentKind) {
      let marker;
      while ((marker = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+|$)/.exec(text))) {
        if (/^ {0,3}(?:[-*][ \t]*){3,}$/.test(text)) break;
        if (paragraphOpen && ((/^\d/.test(marker[2]) && marker[2].slice(0, -1) !== "1")
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
    const linkMetadataText = maskLinkDestinations(parsedText, !paragraphOpen, text, commentKind, referenceLabels).text;
    const metadataText = maskInlineHtmlTags(linkMetadataText, commentKind);
    const metadata = { signature: `${quotes}:${base}:${listIndents.map((entry) => entry.id).join(",")}`, contained: quotes > 0 || base > 0, inline: null, visible: "", open: null, paragraphOpen };
    containers[index] = metadata;
    lines[index] = text + ending;
    if (fence) {
      if (isClosingFence(text, fence)) fence = null;
      continue;
    }
    if (!html && !math && !commentKind && !paragraphOpen && /^(?: {4}|\t)/.test(text)) continue;
    const mathOpener = !math && !html && !commentKind && /^ {0,3}\$\$/.test(parsedText);
    if (math || mathOpener) {
      if (!math) math = { quotes, base };
      if (findUnescaped(parsedText, "$$", mathOpener ? parsedText.indexOf("$$") + 2 : 0) >= 0) math = null;
      paragraphOpen = false;
      table = false;
      continue;
    }
    if (!html) {
      const openHtml = !commentKind && !(persistentHtmlComments && paragraphOpen && /^ {0,3}<!--/.test(parsedText))
        && htmlBlockStart(parsedText, paragraphOpen);
      if (openHtml) html = { ...openHtml, quotes, base };
    }
    if (html) {
      if (html.end ? html.end.test(parsedText) : parsedText.trim() === "") html = null;
      paragraphOpen = false;
      table = false;
      continue;
    }
    // Fence info strings are literal metadata: their comment delimiters never
    // participate in the surrounding Markdown comment state.
    const structuralFence = !commentKind && openingFence(parsedText);
    if (structuralFence) {
      metadata.open = structuralFence;
      fence = { ...structuralFence, quotes, base };
      definitionIndent = null;
      paragraphOpen = false;
      table = false;
      continue;
    }
    metadata.directive = !commentKind && Boolean(directive?.(text) && directive(metadataText));
    const inlineHtmlOpen = findUnescaped(metadataText, "<!--", 0);
    const needsHtmlEnd = !commentKind && inlineHtmlOpen >= 0 && metadataText.indexOf("-->", inlineHtmlOpen + 4) < 0;
    const masked = metadata.directive ? { text: metadataText, commentKind: null }
      : maskComments(metadataText, commentKind, persistentHtmlComments || !needsHtmlEnd || (!/^ {0,3}#{1,6}(?:[ \t]|$)/.test(parsedText)
        && inlineHtmlCloses(lines, index, quotes, base)));
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
    // Discover multiline inline-code masks before treating a directive as a
    // block boundary; a directive-looking line inside a code span stays text.
    if (metadata.directive && codeMasks !== null) {
      definitionIndent = null;
      paragraphOpen = false;
      table = false;
      previousLine = "";
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
    if (lazyContainer) paragraphOpen = true;
    else if (table
      || !masked.text.trim()
      || definitionStart(masked.text)
      || /^ {0,3}#{1,6}(?:[ \t]|$)/.test(masked.text)
      || /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(masked.text)
      || (paragraphOpen && /^ {0,3}(?:=+|-+)[ \t]*$/.test(masked.text))) paragraphOpen = false;
    else if (!/^(?: {4}|\t)/.test(masked.text)) paragraphOpen = true;
    previousLine = masked.text;

  }
  maskInlineCodeSpans(containers);
  maskProjectedComments(containers, directive, persistentHtmlComments);
  const masks = Array.from({ length: lines.length }, (_, index) => [...(codeMasks?.[index] ?? [])]);
  const discovered = inlineCodeMasks(containers);
  const mathMasks = inlineMathMasks(containers);
  const discoveredReferenceLabels = new Set(referenceLabels);
  const linkMasks = multilineLinkMetadataMasks(lines, containers, discoveredReferenceLabels);
  const htmlMasks = multilineInlineHtmlMasks(lines, containers);
  let masksChanged = false;
  for (let index = 0; index < masks.length; index += 1) {
    for (const range of [...discovered[index], ...mathMasks[index], ...linkMasks[index], ...htmlMasks[index]]) {
      if (masks[index].some(({ from, to }) => from === range.from && to === range.to)) continue;
      masks[index].push(range);
      masksChanged = true;
    }
  }
  const labelsChanged = discoveredReferenceLabels.size !== referenceLabels.size;
  return { lines, containers, masks, masksChanged, referenceLabels: discoveredReferenceLabels, labelsChanged };
}

// Directives are preserved only outside comments and opaque Markdown blocks.
// Source layout scanning keeps inline HTML comments open across paragraph breaks;
// footnote reads retain Markdown's existing container and block-boundary behavior.
function projectMarkdown(source, { fragment = false, directive = null, persistentHtmlComments = false } = {}) {
  let codeMasks = null;
  let referenceLabels = new Set();
  let projectionPass = 0;
  while (true) {
    const projected = projectMarkdownPass(source, codeMasks, referenceLabels, fragment, directive, persistentHtmlComments);
    if ((!projected.masksChanged && !projected.labelsChanged && (!directive || projectionPass > 0)) || projectionPass >= projected.lines.length) {
      return { lines: projected.lines, containers: projected.containers };
    }
    codeMasks = projected.masks;
    referenceLabels = projected.referenceLabels;
    projectionPass += 1;
  }
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
    ...start.open, body, closed, contained: start.contained,
    lineStart: from, lineEnd: closed ? end : Math.max(from, end - 1),
    next: closed ? end + 1 : end,
  };
}

function deindentFencedBody(source, handle) {
  if (typeof source !== "string" || !["markers", "fenced"].includes(handle?.syntax)) return source;
  const explicitIndent = Number.isInteger(handle.sourceIndent) && handle.sourceIndent >= 0
    ? handle.sourceIndent : null;
  if (typeof handle.snapshot !== "string" || !Number.isInteger(handle.start)
    || !Number.isInteger(handle.bodyStart)) {
    return explicitIndent === null ? source : splitLines(source).map((line) => deindentSourceLine(line, explicitIndent)).join("");
  }
  if (handle.start < 0 || handle.bodyStart < handle.start || handle.bodyStart > handle.snapshot.length
    || (handle.snapshot[handle.bodyStart - 1] === "\r" && handle.snapshot[handle.bodyStart] === "\n")
    || (handle.start > 0 && !/[\r\n]/.test(handle.snapshot[handle.start - 1]))) return source;
  if (handle.syntax === "markers") {
    return explicitIndent === null ? source : splitLines(source).map((line) => deindentSourceLine(line, explicitIndent)).join("");
  }
  const opener = handle.snapshot.slice(handle.start, handle.bodyStart);
  if (splitLines(opener).length !== 1 || !/[\r\n]$/.test(opener)
    || !openingFence(lineBody(deindentSourceLine(opener, explicitIndent ?? 0)))) return source;
  const indent = explicitIndent ?? /^ */.exec(opener)[0].length;
  return splitLines(source).map((line) => deindentSourceLine(line, indent)).join("");
}

function isEscaped(source, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

module.exports = { deindentFencedBody, lineBody, projectMarkdown, fencedBlock, definitionStart, definitionEnd, definitionBody, isEscaped, linkDefinitionStart, maskLinkDestinations, maskInlineCode, normalizeFootnoteId, inlineCodeBoundary, normalizeReferenceLabel, frontmatterEnd };
