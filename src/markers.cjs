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

function scanEditorLayouts(source) {
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
    let frontmatter = from === 0 && lines[0]?.body === "---";
    for (let index = from; index < to; index += 1) {
      const line = lines[index];
      if (frontmatter) {
        if (index > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line.body)) frontmatter = false;
        continue;
      }
      if (comment) {
        if (comment === "percent-block" ? line.body.trim() === "%%" : line.body.includes(comment)) comment = null;
        continue;
      }
      const marker = markerLine(line.raw);
      const html = line.body.indexOf("<!--");
      if (html >= 0) {
        if (!line.body.includes("-->", html + 4)) comment = "-->";
        continue;
      }
      if (!marker && (line.body.match(/%%/g) || []).length % 2 === 1) {
        comment = line.body.trim() === "%%" ? "percent-block" : "%%";
        continue;
      }
      const open = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line.body);
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

function scanMarkerLayouts(source) {
  return scanEditorLayouts(source).filter((candidate) => candidate.syntax === "markers");
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
