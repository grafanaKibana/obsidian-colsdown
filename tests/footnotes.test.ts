import { createRequire } from "node:module";
import Module from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import * as ObsidianMock from "./obsidian.mock";

interface FootnoteApi {
	collectFootnoteDefinitions: (source: string) => Map<string, string>;
	hasFootnoteReferences: (markdown: string) => boolean;
	hydrateFootnotes: (markdown: string, definitions: Map<string, string>) => string;
}

interface RenderPlugin {
	app: {
		vault: {
			cachedRead: ReturnType<typeof vi.fn>;
			getAbstractFileByPath: ReturnType<typeof vi.fn>;
			modify: ReturnType<typeof vi.fn>;
			process: ReturnType<typeof vi.fn>;
			write: ReturnType<typeof vi.fn>;
		};
		workspace: { getLeavesOfType: ReturnType<typeof vi.fn> };
	};
	settings: { separator: string };
	activeResizers?: Set<() => void>;
	activeFootnoteRenders?: Set<{ sourcePath: string; refresh: () => Promise<void>; dispose: () => void }>;
}

interface RenderContext {
	sourcePath: string;
	addChild: (child: ObsidianMock.MarkdownRenderChild) => void;
	getSectionInfo?: (element: HTMLElement) => { lineEnd: number; lineStart: number; text?: string } | null;
}

interface ColsdownApi {
	refreshFootnoteLayouts: (plugin: RenderPlugin, file: { path: string }) => Promise<void>;
	parseLayout: (
		source: string,
		direction: "row" | "column",
		separator: string,
	) => { items: Array<{ markdown: string }> };
	renderLayout: (
		plugin: RenderPlugin,
		source: string,
		element: HTMLElement,
		context: RenderContext,
		direction: "row" | "column",
	) => Promise<void>;
}

const require = createRequire(import.meta.url);
type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleInternals = Module as unknown as { _load: ModuleLoader };
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => (
	request === "obsidian" ? ObsidianMock : originalLoad.call(Module, request, parent, isMain)
);
let footnotes: FootnoteApi;
let api: ColsdownApi;
try {
	footnotes = require("../src/footnotes.cjs") as FootnoteApi;
	api = require("../src/main.cjs") as ColsdownApi;
} finally {
	moduleInternals._load = originalLoad;
}

const children: ObsidianMock.MarkdownRenderChild[] = [];
afterEach(() => {
	children.splice(0).reverse().forEach((child) => child.unload());
	document.body.replaceChildren();
});

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

const withoutTerminalLineBreak = (value: string) => value.replace(/\r?\n$/, "");
const originalItems = (source: string, direction: "row" | "column" = "row") => (
	api.parseLayout(source, direction, ":::").items.map((item) => item.markdown)
);
const nestedLayoutFences = (depth: number, content: string): string => {
	if (depth === 0) return content;
	const fence = "`".repeat(depth + 2);
	return `${fence}colsdown\n${nestedLayoutFences(depth - 1, content)}\n${fence}`;
};

function renderFixture(
	note: string,
	source: string,
	direction: "row" | "column" = "row",
	options: {
		cachedRead?: () => Promise<string>;
		file?: { path: string } | null;
		sectionInfo?: { lineEnd: number; lineStart: number; text?: string } | null;
		sourcePath?: string;
	} = {},
) {
	const file = { path: "Example.md" };
	const vault = {
		cachedRead: vi.fn(options.cachedRead ?? (async () => note)),
		getAbstractFileByPath: vi.fn(() => options.file === undefined ? file : options.file),
		modify: vi.fn(),
		process: vi.fn(),
		write: vi.fn(),
	};
	const plugin: RenderPlugin = {
		app: { vault, workspace: { getLeavesOfType: vi.fn(() => []) } },
		settings: { separator: ":::" },
	};
	const element = document.createElement("div");
	const context: RenderContext = {
		addChild: (child) => children.push(child),
		getSectionInfo: options.sectionInfo === undefined ? undefined : () => options.sectionInfo ?? null,
		sourcePath: options.sourcePath ?? file.path,
	};
	const result = api.renderLayout(plugin, source, element, context, direction);
	return { context, element, file, plugin, result, vault };
}

describe("footnote source semantics", () => {
	it("collects a definition with its complete multiline source text", () => {
		const source = [
			"Before",
			"[^details]: First line with **formatting**",
			"    continuation with [a link](https://example.com)",
			"",
			"    final paragraph",
			"After",
		].join("\n");

		const definitions = footnotes.collectFootnoteDefinitions(source);
		expect(withoutTerminalLineBreak(definitions.get("details") ?? "")).toBe([
				"[^details]: First line with **formatting**",
				"    continuation with [a link](https://example.com)",
				"",
				"    final paragraph",
			].join("\n"));
	});

	it("preserves CRLF bytes in collected definitions", () => {
		const definition = "[^windows]: First\r\n    second\r\n\r\n    third";
		const [collected] = footnotes.collectFootnoteDefinitions(`${definition}\r\nEnd`).values();
		expect(withoutTerminalLineBreak(collected ?? "")).toBe(definition);
	});

	it("matches native case-insensitive labels and last-definition precedence", () => {
		const source = "[^Mixed]: First definition.\n[^mixed]: Last definition.";

		expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map([
			["mixed", "[^mixed]: Last definition."],
		]));
	});

	it("excludes definition-like YAML frontmatter while preserving a real body definition", () => {
		const source = "\uFEFF---\r\nsummary: |\r\n  [^metadata-only]: Not Markdown.\r\n  [^source]: metadata only\r\n---\r\n[^source]: Real body definition.\r\n";
		const original = source;

		expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map([
			["source", "[^source]: Real body definition.\r\n"],
		]));
		expect(source).toBe(original);
	});

	it("preserves native continuation indentation and excludes an invalid paragraph continuation", () => {
		const source = [
			"[^shape]: First line",
			"  immediate two-space continuation",
			"\timmediate tab continuation",
			"",
			"  outside the footnote",
			"[^paragraph]: First paragraph",
			"",
			"    second paragraph",
		].join("\n");

		const definitions = footnotes.collectFootnoteDefinitions(source);
		expect(withoutTerminalLineBreak(definitions.get("shape") ?? "")).toBe([
				"[^shape]: First line",
				"  immediate two-space continuation",
				"\timmediate tab continuation",
			].join("\n"));
		expect(withoutTerminalLineBreak(definitions.get("paragraph") ?? "")).toBe(
			"[^paragraph]: First paragraph\n\n    second paragraph",
		);
	});

	it("ignores definition-like text in non-layout code and comments", () => {
		const source = [
			"```text",
			"[^backtick]: hidden",
			"```",
			"~~~text",
			"[^tilde]: hidden",
			"~~~",
			"    [^indented]: hidden",
			"<!-- [^comment]: hidden -->",
			"\\[^escaped]: hidden",
			"`[^inline]: hidden`",
			"[^visible]: shown",
		].join("\n");

		expect([...footnotes.collectFootnoteDefinitions(source).values()]).toEqual(["[^visible]: shown"]);
	});

	it("ignores definitions and references inside Obsidian percent comments", () => {
		const source = [
			"Before %% [^inline]: hidden %% after",
			"%%",
			"[^block]: hidden",
			"Reference[^also-hidden]",
			"%%",
			"[^visible]: shown",
		].join("\n");

		expect([...footnotes.collectFootnoteDefinitions(source).values()]).toEqual(["[^visible]: shown"]);
		expect(footnotes.hasFootnoteReferences("%% hidden[^inline] %%")).toBe(false);
		expect(footnotes.hasFootnoteReferences("%%\nhidden[^block]\n%%")).toBe(false);
	});

	it("keeps Unicode labels distinct when lowercase normalization does not equate them", () => {
		const definitions = footnotes.collectFootnoteDefinitions(
			"[^ß]: Eszett definition.\n[^SS]: Double-s definition.",
		);

		expect([...definitions.keys()]).toEqual(["ß", "ss"]);
	});

	it("treats capital and lowercase Eszett as one label with last-definition precedence", () => {
		const definitions = footnotes.collectFootnoteDefinitions(
			"[^ß]: First definition.\n[^ẞ]: Last definition.",
		);

		expect(definitions).toEqual(new Map([["ß", "[^ẞ]: Last definition."]]));
	});

	it("uses whole-string lowercasing when a label expands", () => {
		const definitions = footnotes.collectFootnoteDefinitions(
			"[^İ]: First dotted-I definition.\n[^i̇]: Last dotted-I definition.\n[^i]: Plain-I definition.",
		);

		expect([...definitions.keys()]).toEqual(["i̇", "i"]);
		expect(withoutTerminalLineBreak(definitions.get("i̇") ?? "")).toBe(
			"[^i̇]: Last dotted-I definition.",
		);
		expect(definitions.get("i")).toBe("[^i]: Plain-I definition.");
	});

	it("uses whole-string context when lowercasing Greek sigma labels", () => {
		const definitions = footnotes.collectFootnoteDefinitions(
			"[^ΟΣ]: First final-sigma definition.\n[^ος]: Last final-sigma definition.\n[^οσ]: Standard-sigma definition.",
		);

		expect([...definitions.keys()]).toEqual(["ος", "οσ"]);
		expect(withoutTerminalLineBreak(definitions.get("ος") ?? "")).toBe(
			"[^ος]: Last final-sigma definition.",
		);
		expect(definitions.get("οσ")).toBe("[^οσ]: Standard-sigma definition.");
	});

	it("collects definitions inside recognized layout fences while ordinary nested fences stay opaque", () => {
		const source = [
			"````colsdown",
			"Reference[^inside]",
			":::",
			"```text",
			"[^ordinary]: hidden",
			"```",
			"[^inside]: visible",
			"````",
		].join("\n");

		expect(withoutTerminalLineBreak(
			footnotes.collectFootnoteDefinitions(source).get("inside") ?? "",
		)).toBe("[^inside]: visible");
	});

	it("collects only definitions within the supported six-level layout depth", () => {
		const source = [
			nestedLayoutFences(6, "[^supported]: visible"),
			nestedLayoutFences(7, "[^too-deep]: hidden"),
		].join("\n");

		expect([...footnotes.collectFootnoteDefinitions(source).keys()]).toEqual(["supported"]);
	});

	it.each([
		["- Parent\n    - Child[^note]", true],
		["1. Parent\n   continuation[^note]", true],
		["- Parent\n\t- Child[^note]", true],
		["> - Parent\n>     - Child[^note]", true],
		["    code[^note]", false],
		["\tcode[^note]", false],
		["- Parent\n\n        code[^note]", false],
		["- Parent\n\n      code[^note]", false],
		["<!--\n- Fake\n-->\n    code[^note]", false],
		["> ```text\n> literal[^note]\n> ```", false],
		["- Parent\n    ```text\n    literal[^note]\n    ```", false],
	])("detects references in Markdown containers: %s", (markdown, expected) => {
		expect(footnotes.hasFootnoteReferences(markdown)).toBe(expected);
	});

	it("does not treat a top-level fence as the closer of an implicitly ended quoted fence", () => {
		const note = "> ```text\n> literal\n\n```\n[^note]: literal code\n```\n\n[^real]: Actual definition.";
		expect([...footnotes.collectFootnoteDefinitions(note)]).toEqual([["real", "[^real]: Actual definition."]]);
		expect(footnotes.hasFootnoteReferences(note.replace("[^note]: literal code", "literal[^note]"))).toBe(false);
	});

	it.each(["", "> "])("ends unclosed list fences at their container boundary: %s", (quote) => {
		const note = `${quote}- Parent\n${quote}  \`\`\`text\n${quote}  [^literal]: code\n\n[^real]: Actual definition.`;
		expect([...footnotes.collectFootnoteDefinitions(note)]).toEqual([["real", "[^real]: Actual definition."]]);
	});

	it("removes each parent fence indent before collecting nested definitions", () => {
		const note = "   ````colsdown\n   Outer[^shared]\n      ```stack\n      [^shared]: Nested definition.\n      ```\n   ````";
		expect(withoutTerminalLineBreak(footnotes.collectFootnoteDefinitions(note).get("shared") ?? "")).toBe("[^shared]: Nested definition.");
	});

	it("does not carry list indentation out of an implicitly ended quote", () => {
		const prefix = "> - Parent\n>   ```text\n>   literal\n";
		expect(footnotes.hasFootnoteReferences(prefix + "    code[^bad]")).toBe(false);
		expect(footnotes.collectFootnoteDefinitions(prefix + "    [^bad]: code").size).toBe(0);
	});

	it.each(["2.", "12)"])("does not let ordered marker %s interrupt an existing paragraph", (marker) => {
		expect(footnotes.hasFootnoteReferences(`Paragraph\n${marker} \`\`\`text\n   Visible[^x]`)).toBe(true);
	});

	it("lets ordered lists starting at one interrupt a paragraph, with an opaque fence", () => {
		expect(footnotes.hasFootnoteReferences("Paragraph\n1. ```text\n   Literal[^x]")).toBe(false);
	});

	it.each(["$$\n[^math]: formula annotation\n$$", "> $$\n> [^math]: formula annotation\n> $$", "- Formula\n  $$\n  [^math]: formula annotation\n  $$"])("keeps display math opaque: %s", (math) => {
		expect(footnotes.collectFootnoteDefinitions(math).size).toBe(0);
		expect(footnotes.hasFootnoteReferences(math.replace("[^math]:", "literal[^math]"))).toBe(false);
		expect(footnotes.collectFootnoteDefinitions(math + "\n\n[^real]: Real definition.").get("real")).toBe("[^real]: Real definition.");
	});

	it.each(["Name | Value\n--- | ---\nOne | Two", "| Name | Value |\n| :--- | ---: |\n| One | Two |"])("keeps HTML after a table opaque: %s", (table) => {
		const source = table + "\n<widget>\nHidden[^bad].\n[^bad]: Raw HTML.\n</widget>\n\n[^real]: Actual definition.";
		expect(footnotes.collectFootnoteDefinitions(source).has("bad")).toBe(false);
		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
	});

	it.each(["> Text <!--\n\n", "- Text <!--\n\n", "Text <!--\n\n"])("does not mask a new block after an unclosed inline comment: %s", async (prefix) => {
		const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
		const source = "Visible[^external]";
		const note = prefix + "```colsdown\n" + source + "\n```\n\n[^external]: Outside definition.";
		const fixture = renderFixture(note, source);
		await fixture.result;
		expect(render.mock.calls[0]?.[1]).toContain("[^external]: Outside definition.");
	});

	it("keeps an unterminated inline HTML opener literal within its paragraph", () => {
		expect(footnotes.hasFootnoteReferences("Text <!-- visible[^note].")).toBe(true);
		expect(footnotes.hasFootnoteReferences("--> Text <!-- visible[^note].")).toBe(true);
		expect(footnotes.hasFootnoteReferences("Text <!--\nHidden[^note].\n--> end")).toBe(false);
	});

	it.each(["---", "===", "***", "___", "* * *", "- - -"])("ends inline HTML comment lookahead at %s", (boundary) => {
		expect(footnotes.hasFootnoteReferences(`Text <!--\n${boundary}\nVisible[^note]\n-->`)).toBe(true);
	});

	it.each(["", "> ", "  "])("excludes definition-like table cells in container %s", (prefix) => {
		const table = ["Name | Value", "--- | ---", "[^fake]: literal cell | Other"].map(line => prefix + line).join("\n");
		const source = (prefix === "  " ? "- Table\n" : "") + table + "\n\n[^real]: Actual definition.";
		expect([...footnotes.collectFootnoteDefinitions(source)]).toEqual([["real", "[^real]: Actual definition."]]);
	});

	it("preserves a real definition when its label also starts a table cell", () => {
		const source = "Name | Value\n--- | ---\n[^same]: literal cell | Other\n\n[^same]: Actual definition.";
		expect(footnotes.collectFootnoteDefinitions(source).get("same")).toBe("[^same]: Actual definition.");
	});

	it.each(["", "> "])("preserves valid four-space quoted definition content with outer prefix %s", (prefix) => {
		const source = ["[^note]: First", "    > quoted continuation"].map(line => prefix + line).join("\n");
		expect(footnotes.collectFootnoteDefinitions(source).get("note")).toBe("[^note]: First\n    > quoted continuation");
	});

	it("keeps a two-space blockquote separate from the preceding definition", () => {
		expect(footnotes.collectFootnoteDefinitions("[^note]: First\n  > separate quote\n").get("note")).toBe("[^note]: First\n");
	});

	it("collects quoted definitions without changing their remaining Markdown or line endings", () => {
		const source = "> [^note]: First\r\n>     - child\r\n>\r\n>         code\r\n";
		expect(footnotes.collectFootnoteDefinitions(source).get("note")).toBe("[^note]: First\r\n    - child\r\n\r\n        code\r\n");
	});

	it("detects prose references but excludes definitions, inline notes, escapes, code, and comments", () => {
		expect(footnotes.hasFootnoteReferences("Named[^name] and numeric[^1]")).toBe(true);
		expect(footnotes.hasFootnoteReferences("\\![^after-literal-exclamation]")).toBe(true);
		expect(footnotes.hasFootnoteReferences("![^image-alt]")).toBe(false);
		expect(footnotes.hasFootnoteReferences("[^name]: definition only")).toBe(false);
		expect(footnotes.hasFootnoteReferences("Inline ^[note] only")).toBe(false);
		expect(footnotes.hasFootnoteReferences("\\[^escaped] and `code[^literal]`")).toBe(false);
		expect(footnotes.hasFootnoteReferences("<!-- hidden[^comment] -->")).toBe(false);
		expect(footnotes.hasFootnoteReferences("```text\nhidden[^fence]\n```\n    hidden[^indent]")).toBe(false);
	});
});

describe("footnote hydration", () => {
	it("appends missing definitions after a blank line without changing the item body", () => {
		const definitions = new Map([
			["external", "[^external]: Outside the layout."],
			["unused", "[^unused]: Native Markdown omits unused definitions."],
		]);
		const hydrated = footnotes.hydrateFootnotes("Body[^external]", definitions);

		expect(hydrated.startsWith("Body[^external]\n\n")).toBe(true);
		expect(hydrated).toContain("[^external]: Outside the layout.");
		expect(hydrated).toContain("[^unused]: Native Markdown omits unused definitions.");
	});

	it("keeps an item-local definition authoritative and does not duplicate it", () => {
		const item = "Body[^same]\n\n[^Same]: Local content.";
		const definitions = new Map([["same", "[^same]: External content."]]);

		expect(footnotes.hydrateFootnotes(item, definitions)).toBe(item);
	});

	it("hydrates repeated references with one shared definition", () => {
		const hydrated = footnotes.hydrateFootnotes(
			"First[^shared] and second[^shared].",
			new Map([["shared", "[^shared]: Shared content."]]),
		);

		expect(hydrated.match(/\[\^shared\]:/giu)).toHaveLength(1);
	});

	it("appends a nested-layout definition outside its fence for an outer reference", () => {
		const markdown = [
			"Outer reference[^shared]",
			"",
			"```stack",
			"[^shared]: Definition inside the nested stack.",
			"```",
		].join("\n");
		const definitions = footnotes.collectFootnoteDefinitions(markdown);

		const hydrated = footnotes.hydrateFootnotes(markdown, definitions);

		expect(hydrated.match(/\[\^shared\]:/giu)).toHaveLength(2);
		expect(hydrated.lastIndexOf("[^shared]:")).toBeGreaterThan(markdown.lastIndexOf("```"));
	});

	it("returns the original bytes when no definitions are available", () => {
		for (const markdown of ["Plain body", "Inline ^[note]", "`literal[^external]`"]) {
			expect(footnotes.hydrateFootnotes(markdown, new Map())).toBe(markdown);
		}
	});
});

describe("layout footnote enrichment", () => {
	it("hydrates external and cross-column definitions into transient renderer input", async () => {
		const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
		const source = "External[^outside] and shared[^shared]\n:::\n[^shared]: Cross-column definition.";
		const note = `\`\`\`colsdown\n${source}\n\`\`\`\n\n[^outside]: Definition below the layout.`;
		const fixture = renderFixture(note, source);

		await fixture.result;

		expect(render).toHaveBeenCalledTimes(2);
		expect(render.mock.calls[0]?.[1]).toContain("[^outside]: Definition below the layout.");
		expect(render.mock.calls[0]?.[1]).toContain("[^shared]: Cross-column definition.");
	const secondItem = render.mock.calls[1]?.[1] ?? "";
		expect(secondItem.startsWith("[^shared]: Cross-column definition.")).toBe(true);
		expect(secondItem.match(/\[\^shared\]:/giu)).toHaveLength(1);
		expect(fixture.vault.cachedRead).toHaveBeenCalledTimes(1);
		expect(fixture.vault.modify).not.toHaveBeenCalled();
		expect(fixture.vault.process).not.toHaveBeenCalled();
		expect(fixture.vault.write).not.toHaveBeenCalled();
	});

	it("uses one note read for any number of items", async () => {
		const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
		const source = "One[^shared]\n:::\nTwo[^shared]\n:::\nThree[^shared]";
		const fixture = renderFixture(`\`\`\`colsdown\n${source}\n\`\`\`\n[^shared]: Shared.`, source);

		await fixture.result;

		expect(render).toHaveBeenCalledTimes(3);
		expect(fixture.vault.cachedRead).toHaveBeenCalledTimes(1);
	});

	it("skips note reads for layouts without named references", async () => {
		const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
		const source = "Plain\n:::\nInline ^[note]\n:::\n%% hidden[^external] %%";
		const fixture = renderFixture(`\`\`\`colsdown\n${source}\n\`\`\``, source);

		await fixture.result;

		expect(fixture.vault.cachedRead).not.toHaveBeenCalled();
		expect(render.mock.calls.map((call) => call[1])).toEqual(originalItems(source));
	});

	it.each([
		["missing source path", { sourcePath: "" }],
		["missing source file", { file: null }],
	] as const)("renders original items when the %s prevents enrichment", async (_name, options) => {
		const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
		const source = "Body[^external]\n:::\nSecond";
		const fixture = renderFixture("[^external]: Wrong snapshot.", source, "row", options);

		await fixture.result;

		expect(render.mock.calls.map((call) => call[1])).toEqual(originalItems(source));
	});

	it("renders original items when the note read fails", async () => {
		const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
		const source = "Body[^external]\n:::\nSecond";
		const fixture = renderFixture("unused", source, "row", {
			cachedRead: async () => { throw new Error("Unavailable"); },
		});

		await fixture.result;

		expect(render.mock.calls.map((call) => call[1])).toEqual(originalItems(source));
	});

	it("does not enrich from a snapshot that cannot be matched to the rendered layout", async () => {
		const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
		const source = "Current body[^external]\n:::\nSecond";
		const fixture = renderFixture("Old body[^external]\n\n[^external]: Stale definition.", source);

		await fixture.result;

		expect(render.mock.calls.map((call) => call[1])).toEqual(originalItems(source));
	});

	it("does not enrich when the rendered layout has ambiguous matches in the snapshot", async () => {
		const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
		const source = "Repeated[^external]\n:::\nSecond";
		const block = `\`\`\`colsdown\n${source}\n\`\`\``;
		const fixture = renderFixture(`${block}\n\n${block}\n\n[^external]: Ambiguous.`, source);

		await fixture.result;

		expect(render.mock.calls.map((call) => call[1])).toEqual(originalItems(source));
	});

	it("does not enrich when section coordinates disagree with the matched layout", async () => {
		const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
		const source = "Section[^external]";
		const note = `\`\`\`colsdown\n${source}\n\`\`\`\n\n[^external]: Wrong section.`;
		const fixture = renderFixture(note, source, "row", {
			sectionInfo: { lineEnd: 1000, lineStart: 999, text: note },
		});

		await fixture.result;

		expect(render.mock.calls.map((call) => call[1])).toEqual(originalItems(source));
	});

	it.each(["- ", "1. ", "12) ", "- - ", "> - ", "-\t", "1.\t"])("hydrates a fence opening on a list-marker line: %s", async (marker) => {
		const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
		const source = "Marker[^external]\n:::\n[^shared]: Cross-column definition.\nShared[^shared]";
		const prefix = marker.startsWith("> ") ? ">   " : " ".repeat(marker.includes("\t") ? 4 : marker.length);
		const note = "[^before]: A preceding definition.\n\n" + marker + "```colsdown\n" + [...source.split("\n"), "```"].map((line) => prefix + line).join("\n") + "\n\n[^external]: Outside definition.";
		const fixture = renderFixture(note, source, "row", { sectionInfo: { text: note, lineStart: 2, lineEnd: source.split("\n").length + 3 } });
		await fixture.result;
		expect(render.mock.calls[0]?.[1]).toContain("[^external]: Outside definition.");
		expect(render.mock.calls[0]?.[1]).toContain("[^shared]: Cross-column definition.");
	});

	it("keeps sibling list items separate when the first fence ends implicitly", async () => {
		const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
		const source = "First[^external]";
		const note = "- ```colsdown\n  First[^external]\n- ```colsdown\n  Second[^external]\n  ```\n\n[^external]: Outside sibling definition.";
		const fixture = renderFixture(note, source, "row", { sectionInfo: { text: note, lineStart: 0, lineEnd: 4 } });
		await fixture.result;
		expect(render.mock.calls[0]?.[1]).toContain("[^external]: Outside sibling definition.");
	});

	it.each(["quote", "callout", "list", "nested list", "quoted list", "stack"])("hydrates a layout inside a %s and refreshes its exact fence", async (kind) => {
		vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element) => { element.textContent = markdown; });
		const source = "Contained[^external]\n::: \nOther";
		const prefix = kind === "quote" || kind === "callout" ? "> " : kind === "quoted list" ? ">     " : kind === "nested list" ? "      " : "    ";
		const heading = kind === "callout" ? "> [!note]\n" : kind === "quote" ? "> Container\n" : kind === "quoted list" ? "> - Parent\n" : kind === "nested list" ? "- Parent\n  - Child\n" : "- Parent\n";
		const block = [kind === "stack" ? "```stack" : "```colsdown", ...source.split("\n"), "```"].map((line) => prefix + line).join("\n");
		const note = (heading + block + "\n\n[^external]: OLD container definition.").replace(/\n/g, "\r\n");
		const fixture = renderFixture(note, source, kind === "stack" ? "column" : "row", {
			sectionInfo: { text: note, lineStart: 0, lineEnd: heading.split("\n").length - 1 + source.split("\n").length + 1 },
		});
		document.body.appendChild(fixture.element);
		await fixture.result;
		expect(fixture.element.textContent).toContain("OLD container definition.");
		fixture.vault.cachedRead.mockResolvedValue(note.replace("OLD", "NEW"));
		await api.refreshFootnoteLayouts(fixture.plugin, fixture.file);
		expect(fixture.element.textContent).toContain("NEW container definition.");
		fixture.vault.cachedRead.mockResolvedValue("Inserted\r\n" + note.replace("OLD", "WRONG"));
		await api.refreshFootnoteLayouts(fixture.plugin, fixture.file);
		expect(fixture.element.textContent).not.toContain("WRONG");
		expect(fixture.vault.modify).not.toHaveBeenCalled();
	});

	it("rejects an ambiguous enclosing container and a closer outside its container", async () => {
		vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element) => { element.textContent = markdown; });
		const source = "Contained[^external]";
		for (const block of ["Heading\n```colsdown\n" + source + "\n```", "> ```colsdown\n> " + source + "\n> ```\n> ```colsdown\n> " + source + "\n> ```", "> ```colsdown\n> " + source + "\n```"] ) {
			const note = block + "\n\n[^external]: WRONG container definition.";
			const fixture = renderFixture(note, source, "row", { sectionInfo: { text: note, lineStart: 0, lineEnd: block.split("\n").length - 1 } });
			await fixture.result;
			expect(fixture.element.textContent).not.toContain("WRONG");
		}
	});

	it("maps unique heading-embed section coordinates into the full note", async () => {
		const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
		const source = "Embedded[^external]";
		const section = `### Target\n\n\`\`\`colsdown\n${source}\n\`\`\``;
		const note = `# Before\n\n${section}\n\n[^external]: Available outside the embed.`;
		const fixture = renderFixture(note, source, "row", {
			sectionInfo: { lineStart: 2, lineEnd: 4, text: section },
		});

		await fixture.result;

		expect(render.mock.calls[0]?.[1]).toContain("[^external]: Available outside the embed.");
	});

	it.each(["ambiguous", "stale", "wrong coordinates", "mid-line", "mid-line end", "negative", "out of range", "missing text"] as const)(
		"rejects %s heading-embed source context",
		async (kind) => {
			const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
			const source = "Embedded[^external]";
			const section = `### Target\n\n\`\`\`colsdown\n${source}\n\`\`\``;
			const suffix = kind === "mid-line end" ? " suffix" : "";
			const prefix = kind === "mid-line" ? "Prefix " : "# Before\n\n";
			const note = `${prefix}${section}${suffix}\n\n${kind === "ambiguous" ? section + "\n\n" : ""}[^external]: Must not attach.`;
			const fixture = renderFixture(note, source, "row", {
				sectionInfo: {
					lineStart: kind === "negative" ? -1 : kind === "wrong coordinates" ? 1 : 2,
					lineEnd: kind === "out of range" ? 99 : kind === "wrong coordinates" ? 3 : 4,
					text: kind === "missing text" ? undefined : kind === "stale" ? section.replace("Target", "Old target") : section,
				},
			});

			await fixture.result;

			expect(render.mock.calls.map((call) => call[1])).toEqual(originalItems(source));
		},
	);

	it.each(["full note", "CRLF partial"] as const)("matches %s section provenance", async (kind) => {
		const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
		const source = "Embedded[^external]";
		const section = `### Target\n\n\`\`\`colsdown\n${source}\n\`\`\``.replace(/\n/g, "\r\n");
		const note = `# Before\r\n\r\n${section}\r\n\r\n[^external]: Available.`;
		const fixture = renderFixture(note, source, "row", {
			sectionInfo: kind === "full note"
				? { lineStart: 4, lineEnd: 6, text: note }
				: { lineStart: 2, lineEnd: 4, text: section },
		});

		await fixture.result;

		expect(render.mock.calls[0]?.[1]).toContain("[^external]: Available.");
	});

	it("supports detached containers because lifecycle ownership does not depend on isConnected", async () => {
		const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
		const source = "Detached[^external]";
		const fixture = renderFixture(`\`\`\`stack\n${source}\n\`\`\`\n[^external]: Available.`, source, "column");

		expect(fixture.element.isConnected).toBe(false);
		await fixture.result;

		expect(render).toHaveBeenCalledOnce();
		expect(render.mock.calls[0]?.[1]).toContain("[^external]: Available.");
	});

	it("abandons a late note read after its render owner unloads", async () => {
		const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
		const pendingRead = deferred<string>();
		const source = "Late[^external]";
		const fixture = renderFixture(
			`\`\`\`colsdown\n${source}\n\`\`\`\n[^external]: Late.`,
			source,
			"row",
			{ cachedRead: () => pendingRead.promise },
		);

		expect(children.length).toBeGreaterThan(0);
		children[0]?.unload();
		pendingRead.resolve(`\`\`\`colsdown\n${source}\n\`\`\`\n[^external]: Late.`);
		await fixture.result;

		expect(render).not.toHaveBeenCalled();
	});

	it("stops rendering remaining items when unloaded during an item render", async () => {
		const pendingRender = deferred<void>();
		const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render")
			.mockReturnValueOnce(pendingRender.promise);
		const source = "First[^external]\n:::\nSecond[^external]";
		const fixture = renderFixture(`\`\`\`colsdown\n${source}\n\`\`\`\n[^external]: Shared.`, source);
		await Promise.resolve();
		await Promise.resolve();

		expect(render).toHaveBeenCalledOnce();
		children[0]?.unload();
		pendingRender.resolve();
		await fixture.result;

		expect(render).toHaveBeenCalledOnce();
	});

	it("shows only original item Markdown when rendering hydrated input fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockRejectedValue(new Error("Render failed"));
		const source = "Original[^external]";
		const fixture = renderFixture(`\`\`\`colsdown\n${source}\n\`\`\`\n[^external]: Appended.`, source);

		await fixture.result;

		expect(fixture.element.querySelector(".layout-render-fallback")?.textContent).toBe(source);
		expect(fixture.element.textContent).not.toContain("Appended.");
	});
});


describe("external footnote live refresh", () => {
	const source = "Text[^external]\n:::\nPlain text";
	const snapshot = (definition = "OLD definition.") => `\`\`\`colsdown\n${source}\n\`\`\`${definition ? `\n\n[^external]: ${definition}` : ""}`;

	function visibleRenderer() {
		return vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element) => {
			element.textContent = markdown;
		});
	}

	async function fixture() {
		visibleRenderer();
		const result = renderFixture(snapshot(), source);
		document.body.appendChild(result.element);
		await result.result;
		return result;
	}

	it("tracks named-reference ownership before the read and removes it on unload", async () => {
		const read = deferred<string>();
		const result = renderFixture("", "Text[^external]", "row", { cachedRead: () => read.promise });
		expect(result.plugin.activeFootnoteRenders?.size).toBe(1);
		expect([...result.plugin.activeFootnoteRenders ?? []][0]?.sourcePath).toBe("Example.md");
		children[children.length - 1]?.unload();
		expect(result.plugin.activeFootnoteRenders?.size).toBe(0);
		read.resolve("```colsdown\nText[^external]\n```\n\n[^external]: Definition");
		await result.result;
	});

	it.each(["Plain text", "Inline^[definition]"])("leaves %s outside source-change tracking", async (markdown) => {
		const result = renderFixture(`\`\`\`colsdown\n${markdown}\n\`\`\``, markdown);
		await result.result;
		expect(result.plugin.activeFootnoteRenders?.size ?? 0).toBe(0);
	});

	it.each(["markdown-preview-view", "cm-preview-code-block"])("updates definitions in an owned %s without rebuilding the layout", async (hostClass) => {
		const result = await fixture();
		result.element.classList.add(hostClass);
		const layout = result.element.querySelector(".layout-layout");
		const plainContent = result.element.querySelectorAll(".layout-content")[1];
		result.vault.cachedRead.mockResolvedValue(snapshot("NEW **bold** definition."));
		await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
		expect(result.element.textContent).toContain("NEW **bold** definition.");
		expect(result.element.textContent).not.toContain("OLD definition.");
		expect(result.element.querySelector(".layout-layout")).toBe(layout);
		expect(result.element.querySelectorAll(".layout-content")[1]).toBe(plainContent);
		expect(result.vault.cachedRead).toHaveBeenCalledTimes(2);
		expect(result.vault.modify).not.toHaveBeenCalled();
		expect(result.vault.process).not.toHaveBeenCalled();
		expect(result.vault.write).not.toHaveBeenCalled();
	});

	it.each(["full note", "heading section"] as const)("refreshes with retained %s metadata after initial validation", async (kind) => {
		visibleRenderer();
		const section = `### Target\n\n${snapshot()}`;
		const note = `# Before\n\n${section}`;
		const result = renderFixture(note, source, "row", {
			sectionInfo: kind === "full note"
				? { text: note, lineStart: 4, lineEnd: 8 }
				: { text: section, lineStart: 2, lineEnd: 6 },
		});
		await result.result;
		expect(result.element.textContent).toContain("OLD definition.");
		result.vault.cachedRead.mockResolvedValue(note.replace("OLD definition.", "NEW definition."));
		await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
		expect(result.element.textContent).toContain("NEW definition.");
		expect(result.element.textContent).not.toContain("OLD definition.");

		result.vault.cachedRead.mockResolvedValue(note.replace(source, "Different[^external]").replace("OLD definition.", "WRONG definition."));
		await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
		expect(result.element.textContent).toContain("NEW definition.");
		expect(result.element.textContent).not.toContain("WRONG definition.");
	});

	it("does not relocate a validated fence after lines are inserted above it", async () => {
		const result = await fixture();
		result.vault.cachedRead.mockResolvedValue(`# Inserted\n\n${snapshot("WRONG relocated definition.")}`);
		await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
		expect(result.element.textContent).toContain("OLD definition.");
		expect(result.element.textContent).not.toContain("WRONG relocated definition.");
		result.vault.cachedRead.mockResolvedValue(snapshot("RECOVERED definition."));
		await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
		expect(result.element.textContent).toContain("RECOVERED definition.");
	});

	it("does not establish provenance after invalid initial section mapping", async () => {
		visibleRenderer();
		const result = renderFixture(snapshot(), source, "row", {
			sectionInfo: { text: "Stale section", lineStart: 0, lineEnd: 0 },
		});
		await result.result;
		result.vault.cachedRead.mockResolvedValue(snapshot("WRONG definition."));
		await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
		expect(result.element.textContent).not.toContain("definition.");
	});

	it("removes stale footnotes when a valid snapshot has no definitions", async () => {
		const result = await fixture();
		result.vault.cachedRead.mockResolvedValue(snapshot(""));
		await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
		expect(result.element.textContent).not.toContain("OLD definition.");
		expect(result.element.textContent).toContain("Text[^external]");
	});

	it.each(["read rejection", "unmatched snapshot"])("preserves visible content on %s", async (failure) => {
		const result = await fixture();
		const content = result.element.querySelector(".layout-content");
		if (failure === "read rejection") result.vault.cachedRead.mockRejectedValue(new Error("unavailable"));
		else result.vault.cachedRead.mockResolvedValue("```colsdown\nDifferent body\n```\n[^external]: Wrong definition");
		await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
		expect(result.element.querySelector(".layout-content")).toBe(content);
		expect(result.element.textContent).toContain("OLD definition.");
	});

	it("skips renderer work when definitions and item inputs did not change", async () => {
		const render = visibleRenderer();
		const result = renderFixture(snapshot(), source);
		await result.result;
		await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
		expect(render).toHaveBeenCalledTimes(2);
	});

	it("ignores unrelated files and refreshes each matching owned layout independently", async () => {
		const result = await fixture();
		const first = vi.fn(async () => {});
		const second = vi.fn(async () => {});
		const unrelated = vi.fn(async () => {});
		result.plugin.activeFootnoteRenders = new Set([
			{ sourcePath: "Example.md", refresh: first, dispose: () => {} },
			{ sourcePath: "Example.md", refresh: second, dispose: () => {} },
			{ sourcePath: "Other.md", refresh: unrelated, dispose: () => {} },
		]);
		await api.refreshFootnoteLayouts(result.plugin, { path: "Unrelated.md" });
		expect(first).not.toHaveBeenCalled();
		await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
		expect(unrelated).not.toHaveBeenCalled();
	});

	it("does not let a failed owned refresh starve another layout", async () => {
		const result = await fixture();
		const second = vi.fn(async () => {});
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			result.plugin.activeFootnoteRenders = new Set([
				{ sourcePath: "Example.md", refresh: async () => { throw new Error("failed"); }, dispose: () => {} },
				{ sourcePath: "Example.md", refresh: second, dispose: () => {} },
			]);
			await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
			expect(second).toHaveBeenCalledTimes(1);
			expect(log).toHaveBeenCalled();
		} finally { log.mockRestore(); }
	});

	it("discards a late refresh read after ownership is unloaded", async () => {
		const result = await fixture();
		const before = result.element.textContent;
		const read = deferred<string>();
		result.vault.cachedRead.mockImplementation(() => read.promise);
		const refresh = api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
		children[children.length - 1]?.unload();
		read.resolve(snapshot("LATE definition."));
		await refresh;
		expect(result.element.textContent).toBe(before);
		expect(result.plugin.activeFootnoteRenders?.size).toBe(0);
	});

	it("keeps the newest refresh when a newer event arrives during a read", async () => {
		const result = await fixture();
		const older = deferred<string>();
		result.vault.cachedRead.mockImplementationOnce(() => older.promise).mockResolvedValue(snapshot("NEWEST definition."));
		const oldRefresh = api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
		await vi.waitFor(() => expect(result.vault.cachedRead).toHaveBeenCalledTimes(2));
		const latestRefresh = api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
		older.resolve(snapshot("OLDER definition."));
		await Promise.all([oldRefresh, latestRefresh]);
		expect(result.element.textContent).toContain("NEWEST definition.");
		expect(result.element.textContent).not.toContain("OLDER definition.");
		expect(result.element.querySelectorAll(".layout-content")).toHaveLength(2);
	});

	it("keeps the newest refresh when a newer event arrives during staged rendering", async () => {
		const result = await fixture();
		const olderRender = deferred<void>();
		vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element) => {
			if (markdown.includes("OLDER definition.")) await olderRender.promise;
			element.textContent = markdown;
		});
		result.vault.cachedRead.mockResolvedValueOnce(snapshot("OLDER definition.")).mockResolvedValue(snapshot("NEWEST definition."));
		const oldRefresh = api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
		await vi.waitFor(() => expect(ObsidianMock.MarkdownRenderer.render).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("OLDER definition."), expect.anything(), "Example.md", expect.anything()));
		const latestRefresh = api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
		olderRender.resolve();
		await Promise.all([oldRefresh, latestRefresh]);
		expect(result.element.textContent).toContain("NEWEST definition.");
		expect(result.element.textContent).not.toContain("OLDER definition.");
		expect(result.element.querySelectorAll(".layout-content")).toHaveLength(2);
	});

	 it("preserves all visible items when one staged render fails, then recovers", async () => {
		const pair = "First[^external]\n:::\nSecond[^external]";
		const note = (value: string) => `\`\`\`colsdown\n${pair}\n\`\`\`\n\n[^external]: ${value}`;
		visibleRenderer();
		const result = renderFixture(note("OLD definition."), pair);
		document.body.appendChild(result.element);
		await result.result;
		const oldContents = Array.from(result.element.querySelectorAll(".layout-content"));
		const oldChildren = vi.mocked(ObsidianMock.MarkdownRenderer.render).mock.calls.map((call) => call[4]);
		const oldUnloads = oldChildren.map((child) => vi.spyOn(child, "unload"));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element) => {
				if (markdown.startsWith("Second") && markdown.includes("FAIL definition.")) throw new Error("second item failed");
				element.textContent = markdown;
			});
			result.vault.cachedRead.mockResolvedValue(note("FAIL definition."));
			await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
			expect(Array.from(result.element.querySelectorAll(".layout-content"))).toEqual(oldContents);
			expect(result.element.textContent).not.toContain("FAIL definition.");
			expect(log).toHaveBeenCalled();
			for (const unload of oldUnloads) expect(unload).not.toHaveBeenCalled();
			result.vault.cachedRead.mockResolvedValue(note("RECOVERED definition."));
			await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
			expect(result.element.querySelectorAll(".layout-content")).toHaveLength(2);
			expect(result.element.textContent).not.toContain("OLD definition.");
			expect(result.element.textContent?.match(/RECOVERED definition/g)).toHaveLength(2);
			for (const unload of oldUnloads) expect(unload).toHaveBeenCalledTimes(1);
		} finally { log.mockRestore(); }
	});

	it("renders attached staging with host ancestry and removes staging attributes on commit", async () => {
		const result = await fixture();
		const host = document.createElement("div");
		host.className = "cm-embed-block";
		document.body.appendChild(host);
		host.appendChild(result.element);
		let stagedChild: ObsidianMock.MarkdownRenderChild | undefined;
		vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element, _path, child) => {
			expect(element.closest(".layout-columns-root")).toBe(result.element);
			expect(element.closest(".cm-embed-block")).toBe(host);
			expect(element.getAttribute("aria-hidden")).toBe("true");
			expect(element.classList.contains("colsdown-footnote-staging")).toBe(true);
			stagedChild = child;
			element.textContent = markdown;
		});
		result.vault.cachedRead.mockResolvedValue(snapshot("NEW definition."));
		await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
		const content = result.element.querySelector<HTMLElement>(".layout-content");
		expect(content).toBe(stagedChild?.containerEl);
		expect(content?.hasAttribute("aria-hidden")).toBe(false);
		expect(content?.classList.contains("colsdown-footnote-staging")).toBe(false);
		expect(content?.style.visibility).toBe("");
		expect(content?.style.height).toBe("");
		expect(content?.style.overflow).toBe("");
		expect(content?.style.pointerEvents).toBe("");
	});

	it("discards staged content and unloads its child when the owner unloads mid-render", async () => {
		const result = await fixture();
		const oldContent = result.element.querySelector(".layout-content");
		const gate = deferred<void>();
		let stagingUnload: MockInstance<() => void> | undefined;
		vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element, _path, child) => {
			stagingUnload = vi.spyOn(child, "unload");
			await gate.promise;
			element.textContent = markdown;
		});
		result.vault.cachedRead.mockResolvedValue(snapshot("LATE definition."));
		const refresh = api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
		await vi.waitFor(() => expect(stagingUnload).toBeDefined());
		children[children.length - 1]?.unload();
		gate.resolve();
		await refresh;
		expect(result.element.querySelector(".layout-content")).toBe(oldContent);
		expect(result.element.querySelectorAll(".layout-content")).toHaveLength(2);
		expect(result.element.textContent).not.toContain("LATE definition.");
		expect(stagingUnload).toHaveBeenCalled();
	});

	it("settles on the latest definition when modification arrives during initial reading", async () => {
		visibleRenderer();
		const firstRead = deferred<string>();
		const result = renderFixture("", source, "row", {
			cachedRead: () => firstRead.promise,
			sectionInfo: { text: snapshot("OUTDATED initial definition."), lineStart: 0, lineEnd: 4 },
		});
		document.body.appendChild(result.element);
		result.vault.cachedRead.mockResolvedValue(snapshot("LATEST initial definition."));
		const refresh = api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
		firstRead.resolve(snapshot("OUTDATED initial definition."));
		await Promise.all([result.result, refresh]);
		expect(result.element.textContent).toContain("LATEST initial definition.");
		expect(result.element.textContent).not.toContain("OUTDATED initial definition.");
	});

	it("unloads the current native item children through the plugin-owned disposer", async () => {
		const result = await fixture();
		const itemChildren = vi.mocked(ObsidianMock.MarkdownRenderer.render).mock.calls.map((call) => call[4]);
		const unloads = itemChildren.map((child) => vi.spyOn(child, "unload"));
		const record = [...result.plugin.activeFootnoteRenders ?? []][0];
		record?.dispose();
		for (const unload of unloads) expect(unload).toHaveBeenCalledTimes(1);
		expect(result.plugin.activeFootnoteRenders?.size).toBe(0);
	});

	it("registers one modify listener and disposes owned refreshes with plugin lifecycle", async () => {
		const callbacks = new Set<(file: { path: string }) => Promise<void> | void>();
		const vault = {
			on: vi.fn((_event: string, callback: (file: { path: string }) => Promise<void> | void) => { callbacks.add(callback); return { e: vault, callback }; }),
			offref: (event: unknown) => callbacks.delete((event as { callback: (file: { path: string }) => Promise<void> | void }).callback),
		};
		const Constructor = api as unknown as new () => ObsidianMock.Plugin & {
			onload: () => Promise<void>;
			activeFootnoteRenders?: RenderPlugin["activeFootnoteRenders"];
		};
		const instance = new Constructor();
		instance.app = { vault, workspace: { getLeavesOfType: () => [] } };
		await instance.onload();
		expect(vault.on).toHaveBeenCalledTimes(1);
		expect(vault.on.mock.calls[0]?.[0]).toBe("modify");
		const refresh = vi.fn(async () => {});
		const dispose = vi.fn();
		instance.activeFootnoteRenders = new Set([{ sourcePath: "Example.md", refresh, dispose }]);
		for (const callback of callbacks) await callback({ path: "Example.md" });
		expect(refresh).toHaveBeenCalledTimes(1);
		instance.unload();
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(callbacks.size).toBe(0);
		expect(instance.activeFootnoteRenders?.size ?? 0).toBe(0);
	});
});
