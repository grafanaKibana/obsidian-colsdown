// Marker syntax is intentionally independent of fenced layout separators.
const { splitLines, lineBody, normalizeWidth, widthSource } = require("./layout.cjs");
const MARKER_SEPARATOR = "%% col %%";

function markerLine(line) {
  const match = /^( {0,3})%%[ \t]*(col-start|col-break|col-end|cols|col|endcols)((?::[^\r\n]*?)?)[ \t]*%%[ \t]*$/.exec(lineBody(line));
  if (!match) return null;
  const types = { "col-start": "start", "col-break": "break", "col-end": "end", cols: "start", col: "break", endcols: "end" };
  return { type: types[match[2]], token: match[2], metadata: match[3].trimEnd() };
}

function widthToken(metadata) {
  const value = "(auto|(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:%|fr)?)";
  return new RegExp(`^:(?:w:)?${value}(?=:|,|\\s|$)`, "i").exec(metadata);
}

function markerWidth(metadata) {
  const match = widthToken(metadata);
  if (!match) return { kind: "auto" };
  const value = match[1];
  return normalizeWidth(/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ? `${value}%` : value);
}

function unescapedToken(source, token, from = 0) {
  let index = source.indexOf(token, from);
  while (index >= 0) {
    let escapes = 0;
    for (let before = index - 1; before >= 0 && source[before] === "\\"; before -= 1) escapes += 1;
    if (escapes % 2 === 0) return index;
    index = source.indexOf(token, index + token.length);
  }
  return -1;
}

// Inline code may span lines, but cannot continue through a paragraph break.
// Only matched runs protect comment delimiters; unmatched backticks remain text.
function inlineCodeEnd(source, start, limit) {
  const opener = /^`+/.exec(source.slice(start))[0];
  const remainder = source.slice(start + opener.length, limit);
  const paragraphEnd = /(?:\r\n|\r(?!\n)|\n)[ \t]*(?:\r\n|\r(?!\n)|\n)/.exec(remainder);
  const searchable = paragraphEnd ? remainder.slice(0, paragraphEnd.index) : remainder;
  for (const match of searchable.matchAll(/`+/g)) {
    if (match[0].length === opener.length) return start + opener.length + match.index + match[0].length;
  }
  return -1;
}

function scanEditorLayouts(source, { fragment = false } = {}) {
  const lines = [];
  let offset = 0;
  for (const raw of splitLines(source)) {
    lines.push({ raw, body: lineBody(raw), start: offset, end: offset + raw.length });
    offset += raw.length;
  }
  const found = [];
  function scan(from, to, depth) {
    const stack = [];
    let comment = null;
    let codeEnd = -1;
    const frontmatterEnd = !fragment && from === 0 && lines[0]?.body === "---"
      ? lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line.body)) : -1;
    for (let index = from; index < to; index += 1) {
      const line = lines[index];
      if (index <= frontmatterEnd) continue;
      if (comment) {
        if (comment === "percent-block" ? line.body.trim() === "%%"
          : comment === "-->" ? line.body.includes("-->") : unescapedToken(line.body, comment) >= 0) comment = null;
        continue;
      }
      let visible = line.body;
      for (let cursor = 0; cursor < visible.length;) {
        const absolute = line.start + cursor;
        if (absolute < codeEnd) {
          const end = Math.min(visible.length, codeEnd - line.start);
          visible = visible.slice(0, cursor) + " ".repeat(end - cursor) + visible.slice(end);
          cursor = end;
          continue;
        }
        if (visible[cursor] !== "`") { cursor += 1; continue; }
        let escapes = 0;
        for (let before = cursor - 1; before >= 0 && visible[before] === "\\"; before -= 1) escapes += 1;
        const run = /^`+/.exec(visible.slice(cursor))[0].length;
        // A standalone opening fence is structural, rather than inline code.
        const fence = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line.body);
        if (escapes % 2 || (cursor <= 3 && fence && !fence[3].includes("`"))) { cursor += run; continue; }
        codeEnd = inlineCodeEnd(source, absolute, lines[to - 1]?.end ?? source.length);
        if (codeEnd < 0) cursor += run;
      }
      const marker = markerLine(line.raw) && markerLine(visible);
      const html = unescapedToken(visible, "<!--");
      if (html >= 0) {
        if (!visible.includes("-->", html + 4)) comment = "-->";
        continue;
      }
      let percentCount = 0;
      for (let percent = unescapedToken(visible, "%%"); percent >= 0; percent = unescapedToken(visible, "%%", percent + 2)) percentCount += 1;
      if (!marker && percentCount % 2 === 1) {
        comment = visible.trim() === "%%" ? "percent-block" : "%%";
        continue;
      }
      const open = /^( {0,3})(`{3,}|~{3,})(.*)$/.test(line.body)
        ? /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(visible) : null;
      if (open && !(open[2][0] === "`" && open[3].includes("`"))) {
        let close = index + 1;
        while (close < to) {
          const ending = /^( {0,3})(`+|~+)[ \t]*$/.exec(lines[close].body);
          if (ending && ending[2][0] === open[2][0] && ending[2].length >= open[2].length) break;
          close += 1;
        }
        if (close >= to) break;
        const language = open[3].trim().split(/\s+/)[0];
        if (language === "colsdown" || language === "stack") {
          found.push({
            syntax: "fenced", language, direction: language === "stack" ? "column" : "row",
            depth: depth + stack.length, start: line.start, end: lines[close].end,
            bodyStart: line.end, bodyEnd: lines[close].start,
            body: source.slice(line.end, lines[close].start),
            fence: source.slice(line.start, lines[close].end), lineStart: index, lineEnd: close,
          });
          scan(index + 1, close, depth + stack.length + 1);
        }
        index = close;
        continue;
      }
      if (!marker) continue;
      if (marker.type === "start") stack.push({ index, marker, breaks: [] });
      else if (marker.type === "break" && stack.length) stack[stack.length - 1].breaks.push({ start: line.start, end: line.start + line.body.length, bodyStart: line.end, line: line.body });
      else if (marker.type === "end" && stack.length) {
        const start = stack.pop();
        const opener = lines[start.index];
        const implicitFirst = start.marker.token === "cols" && (
          !start.breaks.length || source.slice(opener.end, start.breaks[0].start).trim() !== ""
        );
        if (implicitFirst) start.breaks.unshift({ implicit: true, start: opener.start, end: opener.start + opener.body.length, bodyStart: opener.end, line: opener.body });
        if (!start.breaks.length) continue;
        const direction = /(?:^|[:,])(?:l:)?stack(?=:|,|\s|$)/.test(start.marker.metadata) ? "column" : "row";
        const candidate = {
          separator: start.marker.token === "col-start" ? "%% col-break %%" : MARKER_SEPARATOR,
          syntax: "markers", language: direction === "column" ? "stack" : "colsdown", direction,
          depth: depth + stack.length, start: lines[start.index].start, end: line.end,
          bodyStart: lines[start.index].start, bodyEnd: line.end, contentEnd: line.start, markers: start.breaks, lineStart: start.index, lineEnd: index,
        };
        candidate.body = source.slice(candidate.start, candidate.end);
        candidate.fence = candidate.body;
        found.push(candidate);
      }
    }
  }
  scan(0, lines.length, 0);
  return found.sort((a, b) => a.start - b.start || b.end - a.end);
}

function scanMarkerLayouts(source, options) {
  return scanEditorLayouts(source, options).filter((candidate) => candidate.syntax === "markers");
}

function parseMarkerLayout(source, direction) {
  const region = scanMarkerLayouts(source).find((candidate) => candidate.start === 0 && candidate.end === source.length);
  const resolvedDirection = direction || region?.direction || "row";
  if (!region) return { syntax: "markers", direction: resolvedDirection, items: [{ width: { kind: "auto" }, markdown: source }], markers: [], separator: MARKER_SEPARATOR };
  const markers = region.markers;
  const items = markers.map((marker, index) => ({
    width: marker.implicit ? { kind: "auto" } : markerWidth(markerLine(marker.line).metadata),
    markdown: source.slice(marker.bodyStart, markers[index + 1]?.start ?? region.contentEnd),
  }));
  return { syntax: "markers", direction: resolvedDirection, items, markers, separator: region.separator };
}

function replaceMarkerWidth(line, percentage) {
  const parts = /^(.*?%%[ \t]*(?:col-break|col))((?::[^\r\n]*?)?)([ \t]*%%[ \t]*)$/.exec(line);
  const metadata = parts[2];
  const token = widthToken(metadata);
  const updated = token
    ? metadata.slice(0, token.index) + `:${percentage}` + metadata.slice(token.index + token[0].length)
    : `:${percentage}${metadata}`;
  return parts[1] + updated + parts[3];
}

function markerTemplate(language, widths) {
  const labels = language === "stack" ? "Section" : "Column";
  const sources = (widths.length ? widths : ["", ""]).map(widthSource);
  const percentageTotal = sources.every((value) => value.endsWith("%"))
    ? sources.reduce((sum, value) => sum + Number(value.slice(0, -1)), 0)
    : 0;
  const body = sources.map((value, index) => {
    const inferredFirst = value === "" || (sources.slice(1).some((width) => width !== "")
      && (value.toLowerCase() === "1fr" || percentageTotal === 100));
    const metadata = value ? `:${value.endsWith("%") ? value.slice(0, -1) : value}` : "";
    const boundary = index === 0 && inferredFirst ? "" : `%% col${metadata} %%\n`;
    return `${boundary}${labels} ${index + 1}`;
  }).join("\n\n");
  return `%% cols${language === "stack" ? ":stack" : ""} %%\n${body}\n%% endcols %%`;
}

module.exports = { MARKER_SEPARATOR, markerLine, markerWidth, scanEditorLayouts, scanMarkerLayouts, parseMarkerLayout, replaceMarkerWidth, markerTemplate };
