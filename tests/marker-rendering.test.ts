import { createRequire } from "node:module";
import Module from "node:module";
import { describe, expect, it, vi } from "vitest";
import * as ObsidianMock from "./obsidian.mock";
const require = createRequire(import.meta.url);
const internals = Module as unknown as { _load: (...args: unknown[]) => unknown };
const load = internals._load;
internals._load = (request, ...args) => request === "obsidian" ? ObsidianMock : load.call(Module, request, ...args);
let api: { layoutItemOffsets: (source: string, parsed: unknown, syntax: string) => number[]; registerMarkerReading: (plugin: unknown, renderer: unknown) => void; renderMarkerMarkdown: (...args: unknown[]) => Promise<void> };
try { api = require("../src/marker-rendering.cjs") as typeof api; } finally { internals._load = load; }
const marker = "%% col-start %%\n%% col-break %%\nLeft\n%% col-break %%\nRight\n%% col-end %%";
const tick = () => new Promise((resolve) => window.setTimeout(resolve, 0));
function harness(source: string) {
  let postprocess: (element: HTMLElement, context: unknown) => void = () => {};
  const owners: ObsidianMock.MarkdownRenderChild[] = [];
  const cleanup: Array<() => void> = [];
  const render = vi.fn(async (_plugin, _markdown, target: HTMLElement, _context: unknown) => { target.textContent = "Rendered layout"; });
  const plugin = { register: (callback: () => void) => cleanup.push(callback),
    registerMarkdownPostProcessor: (callback: typeof postprocess) => { postprocess = callback; },
    app: { vault: { getAbstractFileByPath: () => ({ path: "note.md" }), cachedRead: async () => source } } };
  api.registerMarkerReading(plugin, render);
  const container = document.createElement("div"); container.className = "markdown-preview-section";
  document.body.appendChild(container);
  const sections = new Map<HTMLElement, { lineStart: number; lineEnd: number }>();
  const context = { sourcePath: "note.md", docId: "one", getSectionInfo: (element: HTMLElement) => ({ text: source, ...sections.get(element) }),
    addChild: (owner: ObsidianMock.MarkdownRenderChild) => owners.push(owner) };
  const section = (start: number, end: number, detached = false) => {
    const element = document.createElement("div"); element.className = "el-p";
    const native = document.createElement("p"); native.textContent = "Native"; element.append(native); if (!detached) container.append(element);
    sections.set(element, { lineStart: start, lineEnd: end }); postprocess(element, context); return element;
  };
  return { section, render, container, owners, cleanup, update: (next: string, element: HTMLElement) => { source = next; postprocess(element, context); } };
}
describe("Reading View marker ownership", () => {
  it("renders implicit first columns across ordinary preview sections", async () => {
    const source = "%% cols %%\nFirst\n%% col %%\nSecond\n%% endcols %%";
    const h = harness(source);
    h.section(0, 1);
    expect(h.render).not.toHaveBeenCalled();
    h.section(2, 4);
    await tick();
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(h.container.querySelectorAll(".colsdown-marker-reading")).toHaveLength(1);
  });
  it.each(["\n", "\r\n"])("targets duplicate nested children correctly after an implicit opener (%j)", async (newline) => {
    const source = `%% cols %%\n${marker}\n%% col %%\n${marker}\n%% endcols %%`.replace(/\n/g, newline);
    const parse = (require("../src/markers.cjs") as { parseMarkerLayout: (source: string) => { items: Array<{ markdown: string }> } }).parseMarkerLayout;
    const child = marker.replace(/\n/g, newline);
    const first = source.indexOf(child);
    const second = source.indexOf(child, first + child.length);
    const parsed = parse(source);
    const offsets = api.layoutItemOffsets(source, parsed, "markers");
    expect(offsets).toEqual([first, second]);
    const owner = new ObsidianMock.MarkdownRenderChild(document.createElement("div"));
    const render = vi.fn(async () => {});
    for (const [index, item] of parsed.items.entries()) {
      await api.renderMarkerMarkdown({}, item.markdown, owner.containerEl, {
        sourcePath: "note.md", layoutHandle: { syntax: "markers", source, snapshot: source, location: { lineStart: 0, lineEnd: 14 } },
        layoutItemOffset: offsets[index], layoutSource: source,
      }, owner, render);
    }
    const context = (render.mock.calls[1] as unknown[])[3];
    const childSource = (render.mock.calls[1] as unknown[])[1] as string;
    const edits = require("../src/source-edits.cjs") as {
      prepareSourceEdit: (...args: unknown[]) => Promise<unknown>;
      commitAddedColumn: (app: unknown, prepared: unknown) => Promise<{ source: string }>;
    };
    let current = source;
    const file = { path: "note.md" };
    const app = { vault: { getAbstractFileByPath: () => file, read: async () => current,
      process: async (_file: unknown, update: (source: string) => string) => { current = update(current); } },
      workspace: { getLeavesOfType: () => [] } };
    const prepared = await edits.prepareSourceEdit(app, context, {}, childSource, ":::");
    const saved = await edits.commitAddedColumn(app, prepared);
    expect(current).toBe(source.slice(0, second) + saved.source + source.slice(second + childSource.length));
    expect(parse(saved.source).items).toHaveLength(3);
    expect(current.slice(0, second)).toBe(source.slice(0, second));
  });
  it("registers sections processed while detached once Obsidian mounts them", async () => {
    const h = harness(marker);
    const first = h.section(0, 2, true); const second = h.section(3, 5, true);
    expect(h.render).not.toHaveBeenCalled();
    h.container.append(first, second); await tick();
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(h.container.querySelectorAll(".colsdown-marker-reading")).toHaveLength(1);
    expect(first.querySelector("p")?.hidden).toBe(true);
  });
  it("cancels detached registration when the section unloads before mounting", async () => {
    const h = harness(marker); const section = h.section(0, 5, true);
    h.owners[0]?.unload(); h.container.append(section); await tick();
    expect(h.render).not.toHaveBeenCalled();
  });
  it("waits for all sections, renders exactly once and restores native nodes on unload", async () => {
    const h = harness(marker); const first = h.section(0, 2); expect(h.render).not.toHaveBeenCalled();
    const second = h.section(3, 5); await tick();
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(first.querySelector("p")?.hidden).toBe(true); expect(second.querySelector("p")?.hidden).toBe(true);
    h.owners[1]?.unload();
    expect(first.querySelector("p")?.hidden).toBe(false); expect(h.container.querySelector(".colsdown-marker-reading")).toBeNull();
  });
  it("keeps native content when asynchronous rendering fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(marker); h.render.mockRejectedValueOnce(new Error("render rejected"));
    const section = h.section(0, 5); await tick();
    expect(section.querySelector("p")?.hidden).toBe(false);
    expect(section.querySelector(".colsdown-marker-reading")).toBeNull();
    expect(error).toHaveBeenCalledWith("Colsdown failed to render marker columns.", expect.any(Error));
  });
  it("keeps the replacement record when an obsolete render rejects later", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let rejectOld: (error: Error) => void = () => {};
    const old = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
    const h = harness(marker);
    h.render.mockImplementationOnce(() => old);
    const section = h.section(0, 5);
    h.update(marker.replace("Left", "Changed"), section); await tick();
    rejectOld(new Error("obsolete render rejected")); await tick();
    h.update(marker.replace("Left", "Changed"), section); await tick();
    expect(h.render).toHaveBeenCalledTimes(2);
    expect(h.container.querySelectorAll(".colsdown-marker-reading")).toHaveLength(1);
  });
  it("renders consecutive regions in one paragraph without losing surrounding text", async () => {
    const source = `Before\n${marker}\n${marker}\nAfter`;
    const h = harness(source); h.section(0, source.split("\n").length - 1); await tick();
    expect(h.render).toHaveBeenCalledTimes(2);
    expect(h.container.querySelectorAll(".colsdown-marker-reading")).toHaveLength(1);
  });
  it("retains registered sections when only an outside paragraph changes", async () => {
    const h = harness(`${marker}\n\nAfter`); h.section(0, 5); const after = h.section(7, 7); await tick();
    h.update(`${marker}\n\nChanged`, after); await tick(); expect(h.render).toHaveBeenCalledTimes(2);
    expect(h.container.querySelectorAll(".colsdown-marker-reading")).toHaveLength(1);
  });
  it("uses fresh disk snapshots for external definition refreshes", async () => {
    const h = harness(`${marker}\n\n[^note]: Old`); h.section(0, 5); await tick();
    const context = h.render.mock.calls[0]?.[3] as { layoutHandle: { getSnapshot: () => Promise<string> } };
    const outside = h.section(7, 7);
    h.update(`${marker}\n\n[^note]: New`, outside);
    expect(await context.layoutHandle.getSnapshot()).toContain("[^note]: New");
  });
  it("hydrates a reference before a nested layout with definitions from the trailing segment", async () => {
    const markdown = `Reference[^shared]\n\n${marker}\n\n[^shared]: Shared definition`;
    const renderMarkdown = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
    const owner = new ObsidianMock.MarkdownRenderChild(document.createElement("div"));
    await api.renderMarkerMarkdown({}, markdown, owner.containerEl, {}, owner, vi.fn(async () => {}));
    const prelude = renderMarkdown.mock.calls.find((call) => call[1].includes("Reference[^shared]"));
    expect(prelude?.[1]).toContain("[^shared]: Shared definition");
    expect(markdown).toBe(`Reference[^shared]\n\n${marker}\n\n[^shared]: Shared definition`);
  });
  it("uses break body offsets when an ignored marker prelude duplicates a displayed child", async () => {
    const source = `%% col-start %%\n${marker}\n%% col-break %%\n${marker}\n%% col-end %%`;
    const parse = (require("../src/markers.cjs") as { parseMarkerLayout: (source: string) => { items: Array<{ markdown: string }> } }).parseMarkerLayout;
    const parsed = parse(source);
    const offsets = api.layoutItemOffsets(source, parsed, "markers");
    const displayedStart = source.lastIndexOf(marker);
    expect(offsets).toEqual([displayedStart]);
    const render = vi.fn(async () => {});
    const owner = new ObsidianMock.MarkdownRenderChild(document.createElement("div"));
    await api.renderMarkerMarkdown({}, parsed.items[0]?.markdown, owner.containerEl, {
      layoutHandle: { source, snapshot: source, location: { lineStart: 0, lineEnd: 15 } },
      layoutItemOffset: offsets[0], layoutSource: source,
    }, owner, render);
    expect((render.mock.calls[0] as unknown[])[3]).toMatchObject({
      layoutHandle: { location: { lineStart: source.slice(0, displayedStart).split("\n").length - 1 } },
    });
  });
  it("recreates a coordinator after its final section unloads", async () => {
    const h = harness(marker); h.section(0, 5); await tick();
    h.owners[0]?.unload(); h.section(0, 5); await tick();
    expect(h.render).toHaveBeenCalledTimes(2);
    expect(h.container.querySelectorAll(".colsdown-marker-reading")).toHaveLength(1);
  });
  it("maps normalized fenced Markdown to exact CRLF marker lines", async () => {
    const snapshot = `\`\`\`colsdown\r\n${marker.replace(/\n/g, "\r\n")}\r\n\`\`\``;
    const render = vi.fn(async () => {});
    const owner = new ObsidianMock.MarkdownRenderChild(document.createElement("div"));
    await api.renderMarkerMarkdown({}, marker, owner.containerEl, {
      sourcePath: "note.md", renderSectionInfo: { text: snapshot, lineStart: 0, lineEnd: 6 },
      layoutItemOffset: 0, layoutSource: marker,
    }, owner, render);
    expect((render.mock.calls[0] as unknown[])[3]).toMatchObject({ layoutHandle: { location: { lineStart: 1, lineEnd: 6 } } });
    expect((render.mock.calls[0] as unknown[])[1]).toContain("\r\n");
  });
  it("maps identical nested children using their exact item offsets", async () => {
    const source = `%% col-start %%\n%% col-break %%\n${marker}\n%% col-break %%\n${marker}\n%% col-end %%`;
    const render = vi.fn(async () => {}); const owner = new ObsidianMock.MarkdownRenderChild(document.createElement("div"));
    const first = source.indexOf(marker); const second = source.indexOf(marker, first + marker.length);
    for (const offset of [first, second]) await api.renderMarkerMarkdown({}, marker, owner.containerEl, {
      sourcePath: "note.md", layoutHandle: { source, snapshot: source, location: { lineStart: 0, lineEnd: 15 } }, layoutItemOffset: offset,
    }, owner, render);
    expect(render.mock.calls.map((call) => (call as unknown[])[3])).toMatchObject([
      { layoutHandle: { location: { lineStart: 2 } } }, { layoutHandle: { location: { lineStart: 9 } } },
    ]);
  });
});
