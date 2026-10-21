import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
type Item = { width: { kind: string; value?: number }; markdown: string };
type Region = { start: number; end: number; depth: number; body: string; lineStart: number; lineEnd: number; direction: string };
const { scanMarkerLayouts, parseMarkerLayout } = require("../src/markers.cjs") as {
  scanMarkerLayouts: (source: string) => Region[];
  parseMarkerLayout: (source: string, direction?: string) => { direction: string; items: Item[]; markers: { start: number; end: number; bodyStart: number; line: string; implicit?: boolean }[]; separator: string };
};
const { parseLayout, parseLayoutSource, layoutTemplate, columnTracks, normalizeWidth } = require("../src/layout.cjs") as {
  parseLayout: (source: string) => { items: Item[] };
  parseLayoutSource: (source: string, direction: string, separator: string, syntax: string) => { items: Item[] };
  columnTracks: (items: Item[]) => string;
  normalizeWidth: (width: string) => Item["width"];
  layoutTemplate: (language: string, widths: string[], separator: string, syntax: string) => string;
};
const wrap = (body: string, meta = "") => `%% col-start${meta} %%\n${body}\n%% col-end %%`;

describe("marker layouts", () => {
  it("parses first break as first column and ignores prelude", () => {
    const source = wrap("ignored prelude\n%% col-break:40 %%\nLeft\n%% col-break:w:2fr %%\nRight");
    const parsed = parseMarkerLayout(source);
    expect(parsed.items).toEqual([
      { width: { kind: "percent", value: 40 }, markdown: "Left\n" },
      { width: { kind: "fraction", value: 2 }, markdown: "Right\n" },
    ]);
    expect(source.slice(parsed.markers[0]!.start, parsed.markers[0]!.end)).toBe("%% col-break:40 %%");
  });
  it.each([
    ["40", { kind: "percent", value: 40 }],
    ["25.5%", { kind: "percent", value: 25.5 }],
    ["2fr", { kind: "fraction", value: 2 }],
    ["auto", { kind: "auto" }],
  ])("reads direct and legacy width token %s identically", (token, width) => {
    for (const prefix of [":", ":w:"]) {
      const source = wrap(`%% col-break${prefix}${token}:unknown:99 %%\nText`);
      expect(parseMarkerLayout(source).items).toEqual([{ width, markdown: "Text\n" }]);
    }
  });
  it("parses compact columns and stack metadata while retaining explicit first-column semantics", () => {
    const source = "%% cols %%\n \t\n%% col:40 %%\nLeft\n%% col:2fr %%\nRight\n%% endcols %%";
    const parsed = parseMarkerLayout(source);
    expect(parsed.items).toEqual([
      { width: { kind: "percent", value: 40 }, markdown: "Left\n" },
      { width: { kind: "fraction", value: 2 }, markdown: "Right\n" },
    ]);
    expect(parsed.separator).toBe("%% col %%");
    expect(parseMarkerLayout(wrap("%% col-break %%\nLegacy")).separator).toBe("%% col-break %%");
    for (const metadata of [":stack", ":l:stack"]) {
      expect(parseMarkerLayout(source.replace("%% cols %%", `%% cols${metadata} %%`)).direction).toBe("column");
    }
    for (const invalid of ["%% cols %%\n%% col %%\nUnclosed", "Text %% cols %%\n%% col %%\nText\n%% endcols %%"]) {
      expect(scanMarkerLayouts(invalid)).toEqual([]);
      expect(parseMarkerLayout(invalid).items[0]!.markdown).toBe(invalid);
    }
  });
  it("uses compact opener content as an implicit first column with exact CRLF bounds", () => {
    const source = "%% cols:unknown %%\r\nLeft\r\n%% col:60 %%\r\nRight\r\n%% endcols %%";
    const parsed = parseMarkerLayout(source);
    expect(parsed.items).toEqual([
      { width: { kind: "auto" }, markdown: "Left\r\n" },
      { width: { kind: "percent", value: 60 }, markdown: "Right\r\n" },
    ]);
    expect(parsed.markers[0]).toEqual({ implicit: true, start: 0, end: 18, bodyStart: 20, line: "%% cols:unknown %%" });
    expect(source.slice(parsed.markers[1]!.start, parsed.markers[1]!.end)).toBe("%% col:60 %%");
    expect(columnTracks(parsed.items)).toBe("minmax(0, 40fr) minmax(0, 60fr)");
  });
  it.each(["Text\n", "", " \n\t\n"])("accepts closed compact single columns containing %j", (content) => {
    const source = `%% cols %%\n${content}%% endcols %%`;
    const parsed = parseMarkerLayout(source);
    expect(scanMarkerLayouts(source)).toHaveLength(1);
    expect(parsed.items).toEqual([{ width: { kind: "auto" }, markdown: content }]);
    expect(parsed.markers[0]!.implicit).toBe(true);
    expect(scanMarkerLayouts(wrap("Text"))).toEqual([]);
  });
  it("keeps a nested layout immediately after the opener in the implicit first column", () => {
    const child = wrap("%% col-break %%\nChild");
    const source = `%% cols %%\n${child}\n%% col %%\nOther\n%% endcols %%`;
    const regions = scanMarkerLayouts(source);
    expect(regions.map((region) => region.depth)).toEqual([0, 1]);
    expect(source.slice(regions[1]!.start, regions[1]!.end)).toBe(`${child}\n`);
    expect(parseMarkerLayout(source).items[0]!.markdown).toBe(`${child}\n`);
  });
  it.each([
    ["colsdown", ["", ""], true],
    ["stack", ["", ""], true],
    ["colsdown", ["1fr", "2fr"], true],
    ["colsdown", ["1fr", ""], false],
    ["colsdown", ["1fr", "", ""], false],
    ["colsdown", ["1fr"], false],
    ["colsdown", ["100%"], false],
    ["colsdown", ["40%", "60%"], true],
    ["stack", ["40%", "60%"], true],
    ["colsdown", ["2fr", "1fr"], false],
    ["colsdown", ["20%", "30%"], false],
  ] as const)("omits only inferable first boundaries for %s %j", (language, widths, implicit) => {
    const source = layoutTemplate(language, [...widths], ":::", "markers");
    const parsed = parseMarkerLayout(source);
    expect(parsed.items).toHaveLength(widths.length);
    expect(Boolean(parsed.markers[0]!.implicit)).toBe(implicit);
    expect(columnTracks(parsed.items)).toBe(columnTracks(widths.map((width, index) => ({ width: normalizeWidth(width), markdown: `${index}` }))));
    expect(source.split("\n")[1]).toBe(implicit ? `${language === "stack" ? "Section" : "Column"} 1` : `%% col:${widths[0].replace(/%$/, "")} %%`);
  });
  it.each([true, false])("keeps mixed-family nested layouts scoped (compact parent: %s)", (compactParent) => {
    const legacy = wrap("%% col-break:25 %%\nChild");
    const compact = "%% cols:stack %%\n%% col:25 %%\nChild\n%% endcols %%";
    const child = compactParent ? legacy : compact;
    const source = compactParent
      ? `%% cols %%\n%% col:40 %%\n${child}\n%% col:60 %%\nOther\n%% endcols %%`
      : wrap(`%% col-break:40 %%\n${child}\n%% col-break:60 %%\nOther`);
    const regions = scanMarkerLayouts(source);
    expect(regions.map((region) => region.depth)).toEqual([0, 1]);
    expect(regions[1]!.body).toBe(`${child}\n`);
    expect(source.slice(regions[1]!.start, regions[1]!.end)).toBe(regions[1]!.body);
    expect(parseMarkerLayout(source).items.map((item) => item.width.value)).toEqual([40, 60]);
    expect(parseMarkerLayout(source).items[0]!.markdown).toBe(`${child}\n`);
  });
  it("discovers nested marker layouts and preserves them in the parent column", () => {
    const child = wrap("%% col-break %%\nChild", ":l:stack");
    const source = wrap(`%% col-break %%\n${child}\n%% col-break:auto %%\nSibling`);
    const regions = scanMarkerLayouts(source);
    expect(regions.map((r) => [r.depth, r.direction])).toEqual([[0, "row"], [1, "column"]]);
    expect(parseMarkerLayout(source).items).toHaveLength(2);
    expect(parseMarkerLayout(source).items[0]!.markdown).toBe(`${child}\n`);
    expect(parseMarkerLayout(child).direction).toBe("column");
  });
  it("treats ordinary fences as opaque and scans inside layout fences", () => {
    const marker = wrap("%% col-break %%\nExample");
    const source = `\`\`\`md\n${marker}\n\`\`\`\n\`\`\`colsdown\n${marker}\n\`\`\``;
    expect(scanMarkerLayouts(source)).toHaveLength(1);
    expect(scanMarkerLayouts(source)[0]!.depth).toBe(1);
    const parent = wrap(`%% col-break %%\n\`\`\`md\n%% col-break:30 %%\n\`\`\`\nText`);
    expect(parseMarkerLayout(parent).items).toHaveLength(1);
    expect(parseMarkerLayout(parent).items[0]!.markdown).toContain("%% col-break:30 %%");
  });
  it("rejects unfinished and empty regions and nonstandalone markers", () => {
    for (const source of ["%% col-start %%\n%% col-break %%\nAfter", wrap("Prelude"), "Text %% col-start %%\n%% col-break %%\n%% col-end %%"]) {
      expect(scanMarkerLayouts(source)).toEqual([]);
      expect(parseMarkerLayout(source).items[0]!.markdown).toBe(source);
    }
  });
  it("retains CRLF offsets and exact line bounds", () => {
    const marker = wrap("%% col-break:w:40:unknown %%\nText").replace(/\n/g, "\r\n");
    const note = `Before\r\n${marker}\r\n\r\nAfter`;
    const region = scanMarkerLayouts(note)[0]!;
    expect(region.body).toBe(`${marker}\r\n`);
    expect(note.slice(region.start, region.end)).toBe(region.body);
    expect([region.lineStart, region.lineEnd]).toEqual([1, 4]);
    expect(parseMarkerLayout(region.body).items[0]!.width).toEqual({ kind: "percent", value: 40 });
  });
  it("keeps marker examples in frontmatter and multiline comments inert", () => {
    const example = wrap("%% col-break %%\nExample");
    const note = `---\nexample: |\n${example}\n---\n<!--\n${example}\n-->\n%%\n${example}\n%%\n${example}`;
    const found = scanMarkerLayouts(note);
    expect(found).toHaveLength(1);
    expect(found[0]!.start).toBe(note.lastIndexOf(example));
    const parent = wrap(`%% col-break %%\n<!--\n%% col-break:30 %%\n-->\n%%\n%% col-break:20 %%\n%%\nContent`);
    expect(parseMarkerLayout(parent).items).toHaveLength(1);
    expect(parseMarkerLayout(parent).items[0]!.markdown).toContain("col-break:30");
  });
  it("accepts comma metadata boundaries without adding styling behavior", () => {
    const source = wrap("%% col-break:40,b:blue-soft %%\nText", ":l:stack,gap:20");
    expect(parseMarkerLayout(source).direction).toBe("column");
    expect(parseMarkerLayout(source).items[0]!.width).toEqual({ kind: "percent", value: 40 });
  });
  it("uses explicit dispatch and keeps fenced parser semantics", () => {
    const source = layoutTemplate("colsdown", ["40%", "2fr", ""], "CUSTOM", "markers");
    expect(source).toContain("%% col:40 %%");
    expect(source).toContain("%% col:2fr %%");
    expect(source).not.toContain(":w:");
    expect(source.startsWith("%% cols %%\n")).toBe(true);
    expect(source.endsWith("\n%% endcols %%")).toBe(true);
    expect(parseLayout(source).items).toHaveLength(1);
    expect(parseLayoutSource(source, "row", "CUSTOM", "markers").items).toHaveLength(3);
    expect(layoutTemplate("stack", ["", ""], "::: ", "markers")).toContain("cols:stack");
  });
});
