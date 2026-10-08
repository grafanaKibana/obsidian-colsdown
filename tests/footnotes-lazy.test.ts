import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

interface FootnoteApi {
	collectFootnoteDefinitions: (source: string) => Map<string, string>;
	hasFootnoteReferences: (markdown: string) => boolean;
}

const require = createRequire(import.meta.url);
const footnotes = require("../src/footnotes.cjs") as FootnoteApi;

describe("lazy container continuations", () => {
	it.each([
		"- Text `code\n[^fake]: literal\nend`",
		"> Text `code\n[^fake]: literal\nend`",
	])("keeps an omitted container prefix inside a multiline code span: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
		expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map());
	});

	it.each([
		"- Text `code\n\nVisible[^real]",
		"> Text `code\n# Heading\nVisible[^real]",
		"- Text `code\n- Visible[^real]",
		"> Text `code\n```text\nHidden[^fake]\n```\nVisible[^real]",
	])("ends lazy container state at a Markdown block boundary: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});
});

describe("native ordered-list comment boundaries", () => {
	it.each([["1", true], ["01", false], ["001", false]])("matches native Obsidian paragraph interruption for marker %s", (marker, active) => {
		expect(footnotes.hasFootnoteReferences(`Text <!--\n${marker}. Item\nVisible[^note]\n-->`)).toBe(active);
	});
});

describe("native zero-padded paragraph continuations", () => {
	it.each(["01", "001"])("keeps marker %s inside a complete code-span paragraph", (marker) => {
		const source = `Text \`code\n${marker}. Item\n[^fake]: literal\nend\``;
		expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map());
	});
});

describe("native empty-marker comment boundaries", () => {
	it.each(["+ ", "* ", "1. ", "1) ", "+\t", "1.\t", "+", "*", "1.", "1)"])("retains active references after empty marker %s", (marker) => {
		expect(footnotes.hasFootnoteReferences(`Text <!--\n${marker}\nVisible[^note]\n-->`)).toBe(true);
	});
});
