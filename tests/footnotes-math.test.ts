import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

interface FootnoteApi {
	collectFootnoteDefinitions: (source: string) => Map<string, string>;
	hasFootnoteReferences: (markdown: string) => boolean;
}

const require = createRequire(import.meta.url);
const footnotes = require("../src/footnotes.cjs") as FootnoteApi;

describe("inline math footnote shielding", () => {
	it("keeps references inside complete inline math opaque", () => {
		expect(footnotes.hasFootnoteReferences("$x[^fake]$")).toBe(false);
	});

	it("shields a comment opener inside math without hiding following references", () => {
		expect(footnotes.hasFootnoteReferences("$<!--$ Visible[^note] -->")).toBe(true);
	});

	it("keeps multiline math content opaque within one paragraph", () => {
		const source = "$x\n[^fake]: literal\nend$ Visible[^note].";
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map());
	});

	it.each([
		"$ x[^real] $",
		"$x[^real] $",
		"\\$x[^real]$",
		"$x[^real]\\$",
		"$x[^real]",
		"$x[^real]$2",
	])("leaves invalid or literal delimiters Markdown-active: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it.each([
		"$2[^fake]$",
		"$x[^fake]$a",
		"$x[^fake]$$",
	])("matches native digit and adjacent-dollar delimiter behavior: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
	});

	it.each([
		"Text $$x[^fake]$$",
		"Text $$ x[^fake] $$",
		"Text $$x[^fake] $$",
		"Text $$x\n[^fake]: literal\nend$$",
		"Text \\$$x[^fake]$$",
	])("keeps paragraph-level double-dollar math opaque: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
		expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map());
	});

	it("keeps references after paragraph-level double-dollar math active", () => {
		expect(footnotes.hasFootnoteReferences("Text $$x[^fake]$$ After[^note].")).toBe(true);
	});

	it.each([
		"- Math $x\n[^fake]: literal\nend$",
		"> Math $x\n[^fake]: literal\nend$",
	])("preserves a lazy container across multiline math: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
		expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map());
	});

	it.each([
		"$x\n\nVisible[^real]\nend$",
		"$x\n# Heading\nVisible[^real]\nend$",
		"- $x\n- Visible[^real]\nend$",
		"> $x\n```text\nHidden[^fake]\n```\nVisible[^real]\nend$",
	])("stops multiline math at a block boundary: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it("keeps earlier comments, code, links, and HTML metadata authoritative", () => {
		expect(footnotes.hasFootnoteReferences("Text <!-- $-->$ Visible[^real]")).toBe(true);
		expect(footnotes.hasFootnoteReferences("`$<!--$` Visible[^real] -->")).toBe(true);
		expect(footnotes.hasFootnoteReferences("[docs](https://host/$<!--$) Visible[^real] -->")).toBe(true);
		expect(footnotes.hasFootnoteReferences("<span data-value=\"$<!--$\">x</span> Visible[^real] -->")).toBe(true);
	});
});
