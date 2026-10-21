import { createRequire } from "node:module";
import Module from "node:module";
import * as ObsidianMock from "./obsidian.mock";
import { describe, expect, it, vi } from "vitest";

interface Location { lineStart: number; lineEnd: number }
interface Handle {
	syntax: "markers";
	location?: Location;
	snapshot?: string;
	getSnapshot?: () => string | null;
}
interface Mapping {
	language: string;
	syntax?: string;
	direction?: string;
	previousLocation: Location;
	location: Location;
	previousSource: string;
	source: string;
}
const require = createRequire(import.meta.url);
const { readFootnoteDefinitions, mapFootnoteLayouts } = require("../src/footnotes.cjs") as {
	readFootnoteDefinitions: (app: unknown, context: unknown, element: HTMLElement, source: string,
		direction: string, location?: Location | null) => Promise<{ definitions: Map<string, string>; location: Location } | null>;
	mapFootnoteLayouts: (previous: string, next: string) => Mapping[];
};
const marker = (first = "Text[^shared].", second = "Sibling.") =>
	`%% col-start %%\n%% col-break %%\n${first}\n%% col-break %%\n${second}\n%% col-end %%`;
function fixture(note: string, handle: Handle) {
	const file = { path: "Marker.md" };
	const vault = { cachedRead: vi.fn(async () => note), getAbstractFileByPath: () => file };
	const context = { sourcePath: file.path, layoutHandle: handle };
	return { vault, read: (source: string, location: Location | null = null) =>
		readFootnoteDefinitions({ vault }, context, document.createElement("div"), source, "row", location) };
}

describe("marker footnote source validation", () => {
  it("hydrates an implicit first column and a single-column compact layout", async () => {
    for (const sibling of ["", "\n%% col %%\nSibling."]) {
      const source = `%% cols %%\nText[^shared].${sibling}\n%% endcols %%`;
      const note = `${source}\n\n[^shared]: Shared outside the implicit layout.`;
      const test = fixture(note, { syntax: "markers", location: { lineStart: 0, lineEnd: source.split("\n").length - 1 } });
      expect((await test.read(source))?.definitions.get("shared")).toContain("Shared outside the implicit layout.");
    }
  });
	it("uses unsaved definitions in sibling columns and refreshes from the current editor document", async () => {
		const source = marker("Text[^shared].", "[^shared]: Unsaved sibling.");
		let snapshot = source;
		const test = fixture(marker("Text[^shared].", "[^shared]: Stale disk."), {
			syntax: "markers", location: { lineStart: 0, lineEnd: 5 }, getSnapshot: () => snapshot,
		});
		expect((await test.read(source))?.definitions.get("shared")).toContain("Unsaved sibling.");
		snapshot = `${source}\n\n[^outside]: Newly typed definition.`;
		expect((await test.read(source))?.definitions.get("outside")).toContain("Newly typed definition.");
		expect(test.vault.cachedRead).not.toHaveBeenCalled();
	});

	it("uses supplied marker snapshot for validation and fails closed if its getter becomes unavailable", async () => {
		const source = marker();
		const handle: Handle = { syntax: "markers", snapshot: `${source}\n\n[^shared]: Editor definition.` };
		const test = fixture("Unrelated disk.", handle);
		expect((await test.read(source))?.definitions.get("shared")).toContain("Editor definition.");
		handle.getSnapshot = () => null;
		expect(await test.read(source)).toBeNull();
		expect(test.vault.cachedRead).not.toHaveBeenCalled();
	});

	it("requires exact location for duplicate marker layouts", async () => {
		const source = marker();
		const note = `${source}\n\n${source}\n\n[^shared]: Shared.`;
		const handle: Handle = { syntax: "markers" };
		const test = fixture(note, handle);
		expect(await test.read(source)).toBeNull();
		handle.location = { lineStart: 7, lineEnd: 12 };
		expect((await test.read(source))?.location).toEqual(handle.location);
		expect(await test.read(source, { lineStart: 6, lineEnd: 12 })).toBeNull();
	});

	it("finds markers inside layout fences but does not hydrate fenced example markers", async () => {
		const source = marker();
		const note = `\`\`\`\`colsdown\n${source}\n\`\`\`\`\n\n[^shared]: Nested.`;
		const test = fixture(note, { syntax: "markers", location: { lineStart: 1, lineEnd: 6 } });
		expect((await test.read(source))?.definitions.get("shared")).toContain("Nested.");
		const example = fixture(`\`\`\`markdown\n${source}\n\`\`\`\n\n[^shared]: Example.`, { syntax: "markers" });
		expect(await example.read(source)).toBeNull();
	});

	it("keeps syntax identity when a fenced body resembles a complete marker region", async () => {
		const source = marker();
		const test = fixture(`\`\`\`colsdown\n${source}\n\`\`\`\n\n[^shared]: Nested.`, {
			syntax: "markers", location: { lineStart: 0, lineEnd: 7 },
		});
		expect(await test.read(source)).toBeNull();
	});
});

describe("mixed layout footnote refresh mapping", () => {
	it("maps ancestors, nested markers, fences and later siblings after adding a column", () => {
		const nested = marker("Nested[^shared].");
		const fence = "```stack\nFirst[^shared].\n:::\nSecond\n```";
		const parent = marker(nested, fence);
		const sibling = marker("Later[^shared].");
		const previous = `${parent}\n\n${sibling}\n\n[^shared]: Shared.`;
		const changedNested = nested.replace("%% col-end %%", "%% col-break %%\nNew column\n%% col-end %%");
		const next = previous.replace(nested, changedNested);
		const mappings = mapFootnoteLayouts(previous, next);
		expect(mappings).toHaveLength(4);
		expect(mappings.map((item) => item.syntax ?? "fenced")).toEqual(["markers", "markers", "fenced", "markers"]);
		expect(mappings[0]?.source).toContain(changedNested);
		expect(mappings[1]?.source.trimEnd()).toBe(changedNested);
		expect(mappings[2]?.source).toBe("First[^shared].\n:::\nSecond\n");
		expect(mappings[3]?.source.trimEnd()).toBe(sibling);
		for (const mapping of mappings.slice(2)) {
			expect(mapping.location.lineStart).toBe(mapping.previousLocation.lineStart + 2);
		}
	});

	it("maps width updates without losing unknown marker metadata or sibling source", () => {
		const first = marker().replace("col-break", "col-break:40:unknown:keep");
		const note = `${first}\n\n${marker("Sibling[^shared].")}`;
		const mappings = mapFootnoteLayouts(note, note.replace(":40:", ":w:45:"));
		expect(mappings).toHaveLength(2);
		expect(mappings[0]?.source).toContain(":w:45:unknown:keep");
		expect(mappings[1]?.source).toBe(mappings[1]?.previousSource);
		expect(mappings[0]?.direction).toBe("row");
	});

	it("rejects mapping across a syntax or direction change", () => {
		const source = marker();
		expect(mapFootnoteLayouts(source, source.replace("col-start", "col-start:l:stack"))).toEqual([]);
		expect(mapFootnoteLayouts(source, "```colsdown\nText[^shared].\n:::\nSibling.\n```" )).toEqual([]);
	});
});


interface RenderRecord {
  refresh: () => Promise<void>;
  sourceEdited: (updated: string, saved: unknown, direct?: boolean) => void;
}
interface RenderPlugin {
  app: unknown;
  settings: { separator: string };
  activeFootnoteRenders?: Set<RenderRecord>;
}
type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const internals = Module as unknown as { _load: Loader };
const originalLoad = internals._load;
internals._load = (request, parent, isMain) => request === "obsidian"
  ? ObsidianMock : originalLoad.call(Module, request, parent, isMain);
let renderLayout: (plugin: RenderPlugin, source: string, element: HTMLElement, context: unknown, direction: string) => Promise<void>;
try {
  ({ renderLayout } = require("../src/main.cjs") as { renderLayout: typeof renderLayout });
} finally { internals._load = originalLoad; }

it("refreshes an existing sibling marker render after a preceding layout gains a column", async () => {
  const first = marker("Earlier[^shared].");
  const sibling = marker("Sibling[^shared].");
  let note = `${first}\n\n${sibling}\n\n[^shared]: OLD shared definition.`;
  const file = { path: "Marker.md" };
  const plugin: RenderPlugin = {
    app: { vault: { getAbstractFileByPath: () => file, cachedRead: async () => note },
      workspace: { getLeavesOfType: () => [] } }, settings: { separator: ":::" },
  };
  const children: ObsidianMock.MarkdownRenderChild[] = [];
  const element = document.createElement("div");
  const handle: Handle & { source: string } = { syntax: "markers", source: sibling,
    location: { lineStart: 7, lineEnd: 12 }, getSnapshot: () => note };
  const renderer = vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, target) => {
    target.textContent = markdown;
  });
  try {
    await renderLayout(plugin, sibling, element, { sourcePath: file.path, layoutHandle: handle,
      addChild: (child: ObsidianMock.MarkdownRenderChild) => children.push(child) }, "row");
    expect(element.textContent).toContain("OLD shared definition.");
    const previous = note;
    note = note.replace(first, first.replace("%% col-end %%", "%% col-break %%\nNew column\n%% col-end %%"));
    const record = [...plugin.activeFootnoteRenders ?? []][0];
    record?.sourceEdited("", { layoutMappings: mapFootnoteLayouts(previous, note) });
    note = note.replace("OLD shared", "NEW shared");
    await record?.refresh();
    expect(element.textContent).toContain("NEW shared definition.");
    expect(element.textContent).not.toContain("OLD shared definition.");
    expect(handle.location).toEqual({ lineStart: 9, lineEnd: 14 });
  } finally {
    children.reverse().forEach((child) => child.unload());
    renderer.mockRestore();
  }
});
