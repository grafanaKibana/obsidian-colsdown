import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
type Saved = { source: string; snapshot: string; location: { lineStart: number; lineEnd: number } };
const { rewriteLayoutWidths, appendAutoColumn, prepareSourceEdit, commitWidths, commitAddedColumn } = require("../src/source-edits.cjs") as {
  rewriteLayoutWidths: (source: string, widths: number[], separator: string, syntax: string) => string;
  appendAutoColumn: (source: string, separator: string, syntax: string) => string;
  prepareSourceEdit: (app: unknown, context: unknown, element: unknown, source: string, separator: string) => Promise<unknown>;
  commitWidths: (app: unknown, prepared: unknown, widths: number[]) => Promise<Saved>;
  commitAddedColumn: (app: unknown, prepared: unknown) => Promise<Saved>;
};
const { parseMarkerLayout } = require("../src/markers.cjs") as {
  parseMarkerLayout: (source: string) => { items: { width: { kind: string; value?: number }; markdown: string }[] };
};
const region = "%% col-start:unknown %%\nignored\n%% col-break:40:keep:yes %%\nLeft\n%% col-break:w:60:custom %%\nRight\n%% col-end %%";
function fixture(initial: string) {
  let text = initial;
  const file = { path: "note.md" };
  const app = {
    vault: {
      getAbstractFileByPath: () => file,
      read: vi.fn(async () => text),
      process: vi.fn(async (_file: unknown, update: (source: string) => string) => { text = update(text); }),
    },
    workspace: { getLeavesOfType: vi.fn(() => [] as unknown[]) },
  };
  const context = (source = region, location?: Saved["location"]) => ({
    sourcePath: file.path,
    layoutHandle: { syntax: "markers", direction: "row", source, location },
  });
  return { app, context, text: () => text, set: (value: string) => { text = value; } };
}

describe("marker source edits", () => {
  it("rewrites widths without changing unknown tokens, CRLF, or nested layouts", () => {
    const child = "%% col-start %%\n%% col-break:25 %%\nNested\n%% col-end %%";
    const source = region.replace("Left", child).replace(/\n/g, "\r\n");
    const updated = rewriteLayoutWidths(source, [30, 70], "IGNORED", "markers");
    expect(updated).toBe(source.replace(":40:keep", ":30:keep").replace(":w:60:custom", ":70:custom"));
    expect(updated).toContain(child.replace(/\n/g, "\r\n"));
    expect(() => rewriteLayoutWidths(source, [20, 20], ":::", "markers")).toThrow("add up to 100%");
  });
  it("preserves comma-delimited unknown tokens when resizing", () => {
    const source = region.replace(":40:keep:yes", ":40,b:blue-soft").replace(":w:60:custom", ":w:60,custom:token");
    expect(rewriteLayoutWidths(source, [35, 65], ":::", "markers")).toBe(source.replace(":40,", ":35,").replace(":w:60,", ":65,"));
  });
  it("canonicalizes legacy width tokens while preserving marker whitespace and metadata", () => {
    const source = region
      .replace("%% col-break:40:keep:yes %%", "  %%\tcol-break:w:40:keep:yes \t%%\t")
      .replace(":w:60:custom", ":w:60,custom:token")
      .replace(/\n/g, "\r\n");
    const updated = rewriteLayoutWidths(source, [37.5, 62.5], ":::", "markers");
    expect(updated).toBe(source.replace(":w:40:", ":37.5:").replace(":w:60,", ":62.5,"));
    expect(updated).not.toContain(":w:");
    expect(parseMarkerLayout(updated).items.map((item) => item.width.value)).toEqual([37.5, 62.5]);
  });
  it("does not mistake numeric values in unknown tokens for widths", () => {
    const source = region.replace(":40:keep:yes", ":unknown:40").replace(":w:60:custom", ":unknown:60");
    expect(parseMarkerLayout(source).items.every((item) => item.width.kind === "auto")).toBe(true);
    const saved = rewriteLayoutWidths(source, [35, 65], ":::", "markers");
    expect(saved).toContain(":35:unknown:40");
    expect(saved).toContain(":65:unknown:60");
  });
  it("adds before the end marker and reserves space from all-percent columns", () => {
    const updated = appendAutoColumn(region, "IGNORED", "markers");
    const items = parseMarkerLayout(updated).items;
    expect(items).toHaveLength(3);
    expect(items[0]!.width.value).toBeCloseTo(26.6667);
    expect(items[1]!.width.value).toBe(40);
    expect(items[2]).toEqual({ width: { kind: "auto" }, markdown: "New column\n" });
    expect(updated).toContain(":keep:yes");
    expect(updated).not.toContain(":w:");
    expect(updated.endsWith("%% col-end %%")).toBe(true);
    expect(() => appendAutoColumn("%% col-start %%\nAfter", ":::", "markers")).toThrow("incomplete");
  });
  it("resizes and appends compact columns without changing family, nested source, metadata, or CRLF", () => {
    const nested = region.replace(/\n/g, "\r\n");
    const source = `%% cols:unknown %%\r\n  %%\tcol:40:unknown:90 \t%%\t\r\n${nested}\r\n%% col:w:60,keep:12 %%\r\nRight\r\n%% endcols %%\r\n`;
    const resized = rewriteLayoutWidths(source, [35, 65], ":::", "markers");
    expect(resized).toBe(source.replace(":40:unknown:90", ":35:unknown:90").replace(":w:60,keep:12", ":65,keep:12"));
    const appended = appendAutoColumn(resized, ":::", "markers");
    expect(appended).toContain(nested);
    expect(appended).toContain("%% col %%\r\nNew column\r\n%% endcols %%\r\n");
    const items = parseMarkerLayout(appended).items;
    expect(items).toHaveLength(3);
    expect(items[0]!.width.value).toBeCloseTo(23.3333);
    expect(items[1]!.width.value).toBeCloseTo(43.3333);
    expect(items[2]!.width.kind).toBe("auto");
    expect(appended.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });
  it("saves implicit widths through real boundaries without rewriting the opener or nested content", () => {
    const child = region.replace(/\n/g, "\r\n");
    const source = `%% cols:unknown %%\r\n${child}\r\n%% col:w:60,keep:9 %%\r\nRight\r\n%% col:20:other:8 %%\r\nLast\r\n%% endcols %%\r\n`;
    const resized = rewriteLayoutWidths(source, [25, 35, 40], ":::", "markers");
    expect(resized).toBe(source.replace(":w:60,keep:9", ":35,keep:9").replace(":20:other:8", ":40:other:8"));
    expect(parseMarkerLayout(resized).items.map((item) => item.width)).toEqual([{ kind: "auto" }, { kind: "percent", value: 35 }, { kind: "percent", value: 40 }]);
    expect(parseMarkerLayout(resized).items[0]!.markdown).toBe(`${child}\r\n`);
    expect(appendAutoColumn(resized, ":::", "markers")).toContain("%% col %%\r\nNew column\r\n%% endcols %%\r\n");
  });
  it("appends to a compact single column without adding a redundant first boundary", () => {
    const source = "%% cols %%\nOnly column\n%% endcols %%";
    expect(rewriteLayoutWidths(source, [100], ":::", "markers")).toBe(source);
    const updated = appendAutoColumn(source, ":::", "markers");
    expect(updated).toBe("%% cols %%\nOnly column\n%% col %%\nNew column\n%% endcols %%");
    expect(parseMarkerLayout(updated).items.map((item) => item.markdown)).toEqual(["Only column\n", "New column\n"]);
  });
  it.each(["", " \r\n\t\r\n"])("preserves an empty implicit column when appending (%j)", (content) => {
    const source = `%% cols %%\r\n${content}%% endcols %%\r\n`;
    const updated = appendAutoColumn(source, ":::", "markers");
    expect(updated).toBe(`%% cols %%\r\n%% col %%\r\n${content}%% col %%\r\nNew column\r\n%% endcols %%\r\n`);
    expect(parseMarkerLayout(updated).items.map((item) => item.markdown)).toEqual([content, "New column\r\n"]);
  });
  it("keeps fractional/auto source while appending", () => {
    const source = region.replace(":40", ":2fr").replace(":w:60", "");
    const updated = appendAutoColumn(source, ":::", "markers");
    expect(updated).toContain("col-break:2fr:keep:yes");
    expect(parseMarkerLayout(updated).items).toHaveLength(3);
  });
  it("selects duplicate regions by exact location and returns the full saved source", async () => {
    const f = fixture(`Before\n${region}\nMiddle\n${region}\nAfter`);
    const location = { lineStart: 9, lineEnd: 15 };
    const prepared = await prepareSourceEdit(f.app, f.context(region, location), {}, "unused", ":::");
    const saved = await commitWidths(f.app, prepared, [30, 70]);
    expect(f.text()).toBe(`Before\n${region}\nMiddle\n${saved.source}After`);
    expect(saved.source.startsWith("%% col-start")).toBe(true);
    const next = await prepareSourceEdit(f.app, f.context(saved.source, saved.location), {}, saved.source, ":::");
    const added = await commitAddedColumn(f.app, next);
    expect(parseMarkerLayout(added.source).items).toHaveLength(3);
    expect(f.text()).toContain(`Before\n${region}\nMiddle\n`);
  });
  it("rejects ambiguous, stale location and compare-and-swap conflicts", async () => {
    const f = fixture(`${region}\n${region}`);
    await expect(prepareSourceEdit(f.app, f.context(), {}, region, ":::")).rejects.toThrow("multiple identical");
    await expect(prepareSourceEdit(f.app, f.context(region, { lineStart: 20, lineEnd: 26 }), {}, region, ":::")).rejects.toThrow("exact source match");
    const prepared = await prepareSourceEdit(f.app, f.context(region, { lineStart: 0, lineEnd: 6 }), {}, region, ":::");
    f.set(`${f.text()}\nExternal edit`);
    await expect(commitWidths(f.app, prepared, [30, 70])).rejects.toThrow("note changed");
  });
  it("uses one public editor transaction and rejects editing-mode changes", async () => {
    const f = fixture(`Before\n${region}\nAfter`);
    const transaction = vi.fn();
    const editor = { getValue: f.text, transaction };
    f.app.workspace.getLeavesOfType.mockReturnValue([{ view: { file: f.app.vault.getAbstractFileByPath(), getMode: () => "source", editor } }]);
    const prepared = await prepareSourceEdit(f.app, f.context(region, { lineStart: 1, lineEnd: 7 }), {}, region, ":::");
    const saved = await commitWidths(f.app, prepared, [30, 70]);
    expect(transaction).toHaveBeenCalledExactlyOnceWith({ changes: [{ from: { line: 1, ch: 0 }, to: { line: 8, ch: 0 }, text: saved.source }] });
    expect(f.app.vault.process).not.toHaveBeenCalled();
    f.app.workspace.getLeavesOfType.mockReturnValue([]);
    await expect(commitWidths(f.app, prepared, [30, 70])).rejects.toThrow("mode changed");
  });
  it("preserves final newlines while appending with CRLF", () => {
    const source = `${region.replace(/\n/g, "\r\n")}\r\n`;
    const updated = appendAutoColumn(source, ":::", "markers");
    expect(updated.endsWith("%% col-end %%\r\n")).toBe(true);
    expect(updated).toContain("%% col-break %%\r\nNew column\r\n%% col-end");
    expect(updated.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });
  it("edits a nested region without touching its parent widths", async () => {
    const child = region;
    const parent = `%% col-start %%\n%% col-break:50 %%\n${child}\n%% col-break:50 %%\nOther\n%% col-end %%`;
    const f = fixture(parent);
    const prepared = await prepareSourceEdit(f.app, f.context(child, { lineStart: 2, lineEnd: 8 }), {}, child, ":::");
    const saved = await commitWidths(f.app, prepared, [30, 70]);
    expect(f.text()).toBe(parent.replace(`${child}\n`, saved.source));
    expect(parseMarkerLayout(f.text()).items.map((item) => item.width.value)).toEqual([50, 50]);
  });
});
