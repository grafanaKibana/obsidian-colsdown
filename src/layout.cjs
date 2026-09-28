const CANONICAL_SEPARATOR = ":::";
const MAX_SEPARATOR_LENGTH = 64;

function isValidSeparator(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= MAX_SEPARATOR_LENGTH
    && value.trim().length > 0
    && !/[\p{C}\u2028\u2029`~]/u.test(value);
}

function splitLines(source) {
  if (source === "") return [""];
  const lines = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "\n" && source[index] !== "\r") continue;
    const end = source[index] === "\r" && source[index + 1] === "\n" ? index + 2 : index + 1;
    lines.push(source.slice(start, end));
    start = end;
    index = end - 1;
  }
  if (start < source.length) lines.push(source.slice(start));
  return lines;
}

function lineBody(line) {
  return line.replace(/(?:\r\n|\r|\n)$/, "");
}

function fenceChange(line, openFence) {
  const body = lineBody(line);
  const indentation = /^( {0,3})/.exec(body)[0].length;
  const rest = body.slice(indentation);
  const character = rest[0];
  if (openFence) {
    if (character !== openFence.character) return openFence;
    let length = 0;
    while (rest[length] === character) length += 1;
    return length >= openFence.length && rest.slice(length).trim() === "" ? null : openFence;
  }
  if (character !== "`" && character !== "~") return null;
  let length = 0;
  while (rest[length] === character) length += 1;
  if (length < 3 || (character === "`" && rest.slice(length).includes("`"))) return null;
  return { character, length };
}

function normalizeWidth(metadata) {
  const value = metadata.trim();
  const percent = /^(?:\d+(?:\.\d*)?|\.\d+)%$/.test(value) ? Number(value.slice(0, -1)) : NaN;
  if (Number.isFinite(percent) && percent > 0 && percent <= 100) {
    return { kind: "percent", value: percent };
  }
  const fraction = /^(?:\d+(?:\.\d*)?|\.\d+)fr$/i.test(value) ? Number(value.slice(0, -2)) : NaN;
  if (Number.isFinite(fraction) && fraction > 0) {
    return { kind: "fraction", value: fraction };
  }
  return { kind: "auto" };
}

function markerMetadata(line, separator) {
  const trimmed = lineBody(line).trim();
  if (!trimmed.startsWith(separator)) return null;
  const remainder = trimmed.slice(separator.length);
  if (remainder !== "" && !/^\s/.test(remainder)) return null;
  return remainder.trim();
}

function parseLayout(source, direction = "row", configuredSeparator = CANONICAL_SEPARATOR) {
  const separator = isValidSeparator(configuredSeparator) ? configuredSeparator.trim() : CANONICAL_SEPARATOR;
  const candidates = separator === CANONICAL_SEPARATOR
    ? [CANONICAL_SEPARATOR]
    : [CANONICAL_SEPARATOR, separator];
  const lines = splitLines(source);
  const prefix = [];
  const items = [];
  let current = [];
  let currentWidth = { kind: "auto" };
  let fence = null;
  let lockedSeparator = null;
  const markers = [];
  let offset = 0;

  for (const line of lines) {
    const start = offset;
    offset += line.length;
    if (!fence) {
      const available = lockedSeparator ? [lockedSeparator] : candidates;
      let marker = null;
      for (const candidate of available) {
        const metadata = markerMetadata(line, candidate);
        if (metadata !== null) {
          marker = { separator: candidate, metadata };
          break;
        }
      }
      if (marker) {
        markers.push({ start, end: start + lineBody(line).length, line: lineBody(line) });
        if (!lockedSeparator) {
          lockedSeparator = marker.separator;
          if (prefix.join("").trim() !== "") {
            items.push({ width: { kind: "auto" }, markdown: prefix.join("") });
            current = [];
          } else {
            current = prefix.slice();
          }
        } else {
          items.push({ width: currentWidth, markdown: current.join("") });
          current = [];
        }
        currentWidth = normalizeWidth(marker.metadata);
        continue;
      }
    }

    fence = fenceChange(line, fence);
    if (lockedSeparator) current.push(line);
    else prefix.push(line);
  }

  if (!lockedSeparator) {
    return { direction, items: [{ width: { kind: "auto" }, markdown: source }], markers, separator };
  }
  items.push({ width: currentWidth, markdown: current.join("") });
  return { direction, items, markers, separator: lockedSeparator };
}

function columnTracks(items) {
  if (items.every((item) => item.width.kind === "auto")) {
    return "repeat(auto-fit, minmax(min(100%, var(--layout-min-width)), 1fr))";
  }
  if (items.every((item) => item.width.kind === "percent")) {
    return items.map((item) => `minmax(0, ${item.width.value}fr)`).join(" ");
  }
  const percentage = items.reduce((sum, item) => sum + (item.width.kind === "percent" ? item.width.value : 0), 0);
  // Handwritten mixed widths may leave no room for the remaining columns.
  if (percentage >= 100) return items.map(() => "minmax(0, 1fr)").join(" ");
  const fractions = items.reduce((sum, item) => sum + (item.width.kind === "percent" ? 0 : item.width.kind === "fraction" ? item.width.value : 1), 0);
  // Fractions share the remainder after percentage tracks. All tracks exclude gaps.
  const remaining = 100 - percentage;
  return items.map(({ width }) => {
    const weight = width.kind === "percent" ? width.value
      : remaining * (width.kind === "fraction" ? width.value : 1) / fractions;
    return `minmax(0, ${weight}fr)`;
  }).join(" ");
}

function validateWidths(input) {
  const fields = Array.isArray(input) ? input : typeof input === "string" ? input.split(",") : [];
  if (fields.length < 2 || fields.length > 20) {
    return { widths: [], error: "Enter between 2 and 20 widths, separated by commas." };
  }
  const widths = [];
  for (const field of fields) {
    if (typeof field !== "string") return { widths: [], error: "Each width must be auto, a percentage, or a positive fr value." };
    const value = field.trim();
    if (value === "" || value.toLowerCase() === "auto") { widths.push(""); continue; }
    const width = normalizeWidth(value);
    if (width.kind === "auto") return { widths: [], error: `Invalid width “${value}”. Use auto, 30%, or 2fr.` };
    widths.push(widthSource(width));
  }
  const percentages = widths.filter((width) => width.endsWith("%"));
  const total = percentages.reduce((sum, width) => sum + Number(width.slice(0, -1)), 0);
  if (percentages.length === widths.length && Math.abs(total - 100) > 0.00001) {
    return { widths, error: "Percentage widths must add up to 100%." };
  }
  if (percentages.length !== widths.length && total >= 100) {
    return { widths, error: "Leave some space for auto or fr columns: percentages must total less than 100%." };
  }
  return { widths, error: null };
}

function widthSource(width) {
  const normalized = typeof width === "object" ? width : normalizeWidth(String(width || ""));
  if (normalized.kind === "percent") return `${normalized.value}%`;
  if (normalized.kind === "fraction") return `${normalized.value}fr`;
  return "";
}

function layoutTemplate(language, widths, separator = CANONICAL_SEPARATOR) {
  const marker = isValidSeparator(separator) ? separator.trim() : CANONICAL_SEPARATOR;
  const labels = language === "stack" ? "Section" : "Column";
  const itemWidths = widths.length ? widths : ["", ""];
  const sources = itemWidths.map(widthSource);
  const percentageTotal = sources.every((value) => value.endsWith("%"))
    ? sources.reduce((sum, value) => sum + Number(value.slice(0, -1)), 0)
    : 0;
  const body = itemWidths.map((width, index) => {
    const suffix = sources[index];
    const inferredFirst = suffix === "" || suffix.toLowerCase() === "1fr" || percentageTotal === 100;
    const boundary = language === "colsdown" && index === 0 && inferredFirst
      ? ""
      : `${marker}${suffix ? ` ${suffix}` : ""}\n`;
    return `${boundary}${labels} ${index + 1}`;
  }).join("\n\n");
  return `\`\`\`${language}\n${body}\n\`\`\``;
}


module.exports = { CANONICAL_SEPARATOR, MAX_SEPARATOR_LENGTH, isValidSeparator, splitLines, lineBody, fenceChange, normalizeWidth, markerMetadata, parseLayout, columnTracks, widthSource, layoutTemplate, validateWidths };
