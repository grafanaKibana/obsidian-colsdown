const { splitLines } = require("./layout.cjs");
const { normalizeRenderedBody } = require("./source-edits.cjs");
const { scanEditorLayouts } = require("./markers.cjs");

const LAYOUT_LANGUAGES = new Set(["colsdown", "stack"]);
const MAX_NESTING_DEPTH = 6;

const { deindentFencedBody, lineBody, projectMarkdown, fencedBlock, definitionStart, definitionEnd, definitionBody, isEscaped, linkDefinitionStart, maskLinkDestinations, maskInlineCode, normalizeFootnoteId, inlineCodeBoundary, normalizeReferenceLabel, frontmatterEnd } = require("./markdown-projection.cjs");

function footnoteLayoutFences(source, offset = 0, depth = 0) {
  if (depth > MAX_NESTING_DEPTH) return [];
  const projected = projectMarkdown(source);
  const sourceLines = splitLines(source);
  const found = [];
  for (let index = 0; index < projected.lines.length;) {
    const block = fencedBlock(projected, index);
    if (!block) {
      const start = projected.containers[index];
      if (!start?.table && definitionStart(start?.visible ?? "") && definitionStart(lineBody(projected.lines[index]))) {
        let limit = index + 1;
        while (limit < projected.lines.length && projected.containers[limit]?.signature === start.signature) limit += 1;
        const end = definitionEnd(projected.lines, index, limit);
        const body = definitionBody(projected.lines, index, end);
        found.push(...footnoteLayoutFences(body, offset + index, depth + 1).map((candidate) => ({ ...candidate, contained: true, inDefinition: true })));
        index = end;
      } else index += 1;
      continue;
    }
    if (LAYOUT_LANGUAGES.has(block.language)) {
      found.push({ ...block, depth,
        rawBody: !block.contained ? sourceLines.slice(block.lineStart + 1, block.closed ? block.lineEnd : block.next).join("") : null,
        lineStart: offset + block.lineStart, lineEnd: offset + block.lineEnd });
      found.push(...footnoteLayoutFences(block.body, offset + block.lineStart + 1, depth + 1));
    }
    index = block.next;
  }
  return found;
}

// Discover marker regions before Markdown comment projection removes their delimiters.
// Fenced candidates keep their existing projected Markdown/container semantics.
function footnoteLayouts(source) {
  const scanned = scanEditorLayouts(source);
  const markers = scanned.filter((candidate) => candidate.syntax === "markers");
  const rawFences = scanned.filter((candidate) => candidate.syntax === "fenced");
  const fences = footnoteLayoutFences(source).map((candidate) => {
    const raw = rawFences.find((fence) => fence.lineStart === candidate.lineStart && fence.lineEnd === candidate.lineEnd);
    return {
      ...candidate,
      ...(raw ? { rawBody: raw.body, sourceIndent: raw.sourceIndent, start: raw.start, bodyStart: raw.bodyStart } : {}),
      depth: candidate.depth + markers.filter((marker) => (
        marker.lineStart < candidate.lineStart && marker.lineEnd > candidate.lineEnd
      )).length,
    };
  });
  return [...fences, ...markers].sort((left, right) => (
    left.lineStart - right.lineStart || right.lineEnd - left.lineEnd
  ));
}

function mapFootnoteLayouts(previousSnapshot, snapshot) {
  const previous = footnoteLayouts(previousSnapshot);
  const current = footnoteLayouts(snapshot);
  if (previous.length !== current.length || previous.some((candidate, index) => {
    const updated = current[index];
    return (candidate.syntax ?? "fenced") !== (updated.syntax ?? "fenced")
      || candidate.language !== updated.language
      || candidate.character !== updated.character
      || candidate.length !== updated.length
      || candidate.depth !== updated.depth
      || Boolean(candidate.contained) !== Boolean(updated.contained)
      || Boolean(candidate.inDefinition) !== Boolean(updated.inDefinition);
  })) return [];
  return previous.map((candidate, index) => ({
    language: candidate.language,
    ...(candidate.syntax === "markers" ? { syntax: "markers", direction: candidate.direction } : {}),
    previousLocation: { lineStart: candidate.lineStart, lineEnd: candidate.lineEnd },
    location: { lineStart: current[index].lineStart, lineEnd: current[index].lineEnd },
    previousSource: candidate.body,
    source: current[index].body,
    ...(Number.isInteger(current[index].sourceIndent) ? { sourceIndent: current[index].sourceIndent } : {}),
    ...(Number.isInteger(current[index].start) ? { start: current[index].start, bodyStart: current[index].bodyStart } : {}),
    ...(typeof candidate.rawBody === "string" && typeof current[index].rawBody === "string"
      ? { previousRawSource: candidate.rawBody, rawSource: current[index].rawBody } : {}),
  }));
}

function collectDefinitions(source, includeLayouts, depth = 0, options) {
  const projected = projectMarkdown(typeof source === "string" ? source : "", options);
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
    if (depth < MAX_NESTING_DEPTH) {
      const body = definitionBody(lines, index, end);
      for (const [id, raw] of collectDefinitions(body, includeLayouts, depth + 1)) definitions.set(id, raw);
    }
    index = Math.max(index + 1, end);
  }
  return definitions;
}

function collectFootnoteDefinitions(source, options) {
  return collectDefinitions(source, true, 0, options);
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

function multilineLinkDefinitionEnd(projected, index, line, unmasked = false) {
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
    const nextLine = unmasked ? lineBody(projected.lines[cursor + 1] ?? "") : next?.visible;
    if (!next
      || next.signature !== signature
      || next.inline === null
      || inlineCodeBoundary(unmasked ? { ...next, inline: nextLine } : next)) return lastComplete;
    joined += ` ${nextLine.trimStart()}`;
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
  if (/(?:\r\n|\r(?!\n)|\n){2}$/.test(source)) return source + addition;
  if (/(?:\r\n|\r|\n)$/.test(source)) return source + lineEnding + addition;
  return source + lineEnding + lineEnding + addition;
}

function collectReferenceDefinitions(markdown, options) {
  const projected = projectMarkdown(markdown, options);
  const definitions = new Map();
  let previousEnd = -2;
  for (let index = 0; index < projected.lines.length;) {
    const block = fencedBlock(projected, index);
    if (block) { index = block.next; continue; }
    const line = projected.containers[index]?.visible ?? "";
    const definition = linkDefinitionStart(line);
    // Adjacent definitions continue the same definition block, not a paragraph.
    if (definition && index === previousEnd + 1) projected.containers[index].paragraphOpen = false;
    const end = definition ? multilineLinkDefinitionEnd(projected, index, lineBody(projected.lines[index]), true) : -1;
    if (end < index) { index += 1; continue; }
    const id = normalizeReferenceLabel(definition[1]);
    if (!definitions.has(id)) definitions.set(id, projected.lines.slice(index, end + 1).join(""));
    previousEnd = end;
    index = end + 1;
  }
  return definitions;
}

function hydrateDefinitions(markdown, definitions, collect, normalize) {
  if (!(definitions instanceof Map) || definitions.size === 0) return markdown;
  const own = collect(markdown);
  const missing = new Map();
  for (const [id, raw] of definitions) {
    const normalized = normalize(id);
    if (!normalized || own.has(normalized) || typeof raw !== "string" || raw === "") continue;
    own.set(normalized, raw);
    missing.set(normalized, raw);
  }
  if (missing.size === 0) return markdown;
  const lineEnding = preferredLineEnding(markdown);
  let hydrated = markdown;
  for (const definition of missing.values()) hydrated = appendWithBlankLine(hydrated, definition, lineEnding);
  const appended = collect(hydrated);
  if ([...missing.keys()].every((id) => appended.has(id))) return hydrated;

  const lines = splitLines(markdown);
  const yamlEnd = frontmatterEnd(lines);
  let prefix = lines.slice(0, yamlEnd).join("");
  let body = lines.slice(yamlEnd).join("");
  if (!prefix && body.startsWith("\uFEFF")) {
    prefix = "\uFEFF";
    body = body.slice(1);
  }
  for (const definition of missing.values()) prefix = appendWithBlankLine(prefix, definition, lineEnding);
  return appendWithBlankLine(prefix, `<!-- -->${lineEnding}${lineEnding}${body}`, lineEnding);
}

function hydrateFootnotes(markdown, definitions, options) {
  return hydrateDefinitions(markdown, definitions, (source) => collectDefinitions(source, false, 0, options), normalizeFootnoteId);
}

function hydrateReferenceDefinitions(markdown, definitions, options) {
  if (options?.authoritative) {
    const prefix = hydrateDefinitions("", definitions, collectReferenceDefinitions, normalizeReferenceLabel);
    return prefix ? appendWithBlankLine(prefix, markdown, preferredLineEnding(markdown)) : markdown;
  }
  return hydrateDefinitions(markdown, definitions, (source) => collectReferenceDefinitions(source, options), normalizeReferenceLabel);
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
  if (!hasFootnoteReferences(deindentFencedBody(source, context?.layoutHandle))) return null;
  const path = context?.sourcePath;
  if (typeof path !== "string" || path.length === 0) return null;
  const file = app?.vault?.getAbstractFileByPath?.(path);
  if (!file || file.path !== path) return null;
  const handle = context?.layoutHandle;
  const markerContext = handle?.syntax === "markers";
  const hasLayoutContext = markerContext || handle?.syntax === "fenced";
  try {
    let snapshot;
    if (hasLayoutContext && typeof handle.getSnapshot === "function") snapshot = await handle.getSnapshot();
    else if (hasLayoutContext && typeof handle.snapshot === "string") snapshot = handle.snapshot;
    else {
      if (typeof app?.vault?.cachedRead !== "function") return null;
      snapshot = await app.vault.cachedRead(file);
    }
    if (typeof snapshot !== "string") return null;
    const language = direction === "column" ? "stack" : "colsdown";
    const expected = normalizeRenderedBody(source);
    if (validatedLocation === null && hasLayoutContext && handle.location) validatedLocation = handle.location;
    const candidates = footnoteLayouts(snapshot).filter((candidate) => (
      (candidate.syntax ?? "fenced") === (markerContext ? "markers" : "fenced")
      && candidate.language === language && (normalizeRenderedBody(candidate.body) === expected
        // Live Preview retains raw fence indentation for source edits, while
        // native Markdown rendering removes the opening fence indentation.
        || (hasLayoutContext && validatedLocation !== null && typeof candidate.rawBody === "string"
          && normalizeRenderedBody(candidate.rawBody) === expected))
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
      snapshot,
    };
  } catch {
    return null;
  }
}

module.exports = {
  collectFootnoteDefinitions,
  hasFootnoteReferences,
  hydrateFootnotes,
  collectReferenceDefinitions,
  hydrateReferenceDefinitions,
  mapFootnoteLayouts,
  readFootnoteDefinitions,
};
