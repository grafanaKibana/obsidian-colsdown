import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

interface FootnoteApi {
	collectFootnoteDefinitions: (source: string) => Map<string, string>;
	hydrateFootnotes: (source: string, definitions: Map<string, string>) => string;
}
const require = createRequire(import.meta.url);
const footnotes = require("../src/footnotes.cjs") as FootnoteApi;
const definitions = new Map([["note", "[^note]: External definition."]]);

describe("hydration outside trailing opaque blocks", () => {
	it.each(["`````text\nunclosed", "~~~~~text\nunclosed", "$$\nunclosed", "<!--\nunclosed", "<script>\nunclosed", "<?processing\nunclosed", "<![CDATA[\nunclosed", "<!DECLARATION\nunclosed", "%% unclosed"])("prefixes missing definitions without closing the trailing construct %s", (tail) => {
		const source = `Use[^note]\n\n${tail}`;
		const hydrated = footnotes.hydrateFootnotes(source, definitions);
		expect(hydrated).toBe(`[^note]: External definition.\n\n<!-- -->\n\n${source}`);
		expect(footnotes.collectFootnoteDefinitions(hydrated).get("note")).toBe("[^note]: External definition.\n");
	});

	it.each(["<div>\nHTML", "    indented code", "Text <!-- literal opener", "```text\nclosed\n```"])("keeps ordinary append behavior when a blank line exposes definitions: %s", (tail) => {
		const source = `Use[^note]\n\n${tail}`;
		expect(footnotes.hydrateFootnotes(source, definitions)).toBe(`${source}\n\n[^note]: External definition.`);
	});

	it("adds a blank line after a single terminal CRLF", () => {
		expect(footnotes.hydrateFootnotes("Use[^note]\r\n", definitions)).toBe("Use[^note]\r\n\r\n[^note]: External definition.");
	});

	it("keeps local definitions authoritative during prefix fallback", () => {
		const source = "Use[^local] and external[^note].\n\n[^local]: Local definition.\n\n```text\nunclosed";
		const hydrated = footnotes.hydrateFootnotes(source, new Map([...definitions, ["local", "[^local]: Other definition."]]));
		expect(hydrated).toBe(`[^note]: External definition.\n\n<!-- -->\n\n${source}`);
	});

	it.each(["[^host]: [^nested]: Local.", "[^host]:\n    [^nested]: Local."])("keeps nested item-local definitions authoritative: %s", (body) => {
		const source = `Use[^nested]\n\n${body}`;
		expect(footnotes.hydrateFootnotes(source, new Map([["nested", "[^nested]: External."]]))).toBe(source);
	});

	it("preserves nested local authority while prefixing a different missing definition", () => {
		const source = "Use[^nested] and external[^note].\n\n[^host]: [^nested]: Local.\n\n```text\nunclosed";
		const hydrated = footnotes.hydrateFootnotes(source, new Map([...definitions, ["nested", "[^nested]: External."]]));
		expect(hydrated).toBe(`[^note]: External definition.\n\n<!-- -->\n\n${source}`);
	});

	it("keeps definitions in a nested footnote layout separate from item-local definitions", () => {
		const source = "Use[^nested]\n\n[^host]: ```stack\n    [^nested]: Inside layout.\n    ```";
		const hydrated = footnotes.hydrateFootnotes(source, new Map([["nested", "[^nested]: Shared definition."]]));
		expect(hydrated).toBe(`${source}\n\n[^nested]: Shared definition.`);
	});

	it.each(["    leading code", "\tleading code", "    - indented list"])("keeps leading indented content outside the injected definition: %s", (leading) => {
		const source = `${leading}\n\nUse[^note]\n\n\`\`\`text\nunclosed`;
		const hydrated = footnotes.hydrateFootnotes(source, definitions);
		expect(hydrated).toBe(`[^note]: External definition.\n\n<!-- -->\n\n${source}`);
		expect(footnotes.collectFootnoteDefinitions(hydrated).get("note")).toBe("[^note]: External definition.\n");
	});

	it("preserves leading frontmatter and CRLF before the fallback prefix", () => {
		const header = "\uFEFF---\r\ntitle: Example\r\n---\r\n";
		const body = "Use[^note]\r\n\r\n```text\r\nunclosed";
		const hydrated = footnotes.hydrateFootnotes(header + body, definitions);
		expect(hydrated).toBe(`${header}\r\n[^note]: External definition.\r\n\r\n<!-- -->\r\n\r\n${body}`);
		expect(footnotes.collectFootnoteDefinitions(hydrated).has("note")).toBe(true);
	});

	it("preserves a standalone leading BOM during fallback", () => {
		const body = "Use[^note]\n\n```text\nunclosed";
		const hydrated = footnotes.hydrateFootnotes(`\uFEFF${body}`, definitions);
		expect(hydrated).toBe(`\uFEFF\n\n[^note]: External definition.\n\n<!-- -->\n\n${body}`);
		expect(footnotes.collectFootnoteDefinitions(hydrated).has("note")).toBe(true);
	});

	it("keeps a nested layout body unchanged before an open trailing fence", () => {
		const source = "Use[^note]\n\n```stack\nNested content\n```\n\n`````text\nunclosed";
		expect(footnotes.hydrateFootnotes(source, definitions)).toBe(`[^note]: External definition.\n\n<!-- -->\n\n${source}`);
	});
});
