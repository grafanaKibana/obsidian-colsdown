import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

interface FootnoteApi {
	collectFootnoteDefinitions: (source: string) => Map<string, string>;
	hasFootnoteReferences: (markdown: string) => boolean;
}

const require = createRequire(import.meta.url);
const footnotes = require("../src/footnotes.cjs") as FootnoteApi;

describe("footnote HTML boundaries", () => {
	it("uses backslash parity for escaped HTML comment openers", () => {
		const odd = "\\<!-- literal opener\nVisible[^odd].\n[^odd]: Kept.";
		const even = "\\\\<!-- real comment\nHidden[^even].\n[^even]: Hidden.\n-->";

		expect(footnotes.hasFootnoteReferences(odd)).toBe(true);
		expect(footnotes.collectFootnoteDefinitions(odd)).toEqual(new Map([
			["odd", "[^odd]: Kept."],
		]));
		expect(footnotes.hasFootnoteReferences(even)).toBe(false);
		expect(footnotes.collectFootnoteDefinitions(even)).toEqual(new Map());
	});

	it("ignores references and definitions inside literal-content HTML blocks", () => {
		const rawBlock = [
			"<pre>",
			"Hidden[^inside].",
			"[^inside]: Raw HTML, not Markdown.",
			"",
			"</pre>",
		].join("\n");
		const source = [
			rawBlock,
			"Outside[^outside].",
			"[^outside]: Real definition.",
		].join("\n");

		expect(footnotes.hasFootnoteReferences(rawBlock)).toBe(false);
		expect(footnotes.collectFootnoteDefinitions(rawBlock)).toEqual(new Map());
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map([
			["outside", "[^outside]: Real definition."],
		]));
	});

	it("resumes Markdown scanning after blank-terminated HTML blocks", () => {
		for (const opening of ["<div>", "<widget data-kind=\"example\">"]) {
			const rawBlock = [
				opening,
				"Hidden[^inside].",
				"[^inside]: Raw HTML, not Markdown.",
				"",
			].join("\n");
			const source = [
				rawBlock,
				"Outside[^outside].",
				"[^outside]: Real definition.",
			].join("\n");

			expect(footnotes.hasFootnoteReferences(rawBlock)).toBe(false);
			expect(footnotes.collectFootnoteDefinitions(rawBlock)).toEqual(new Map());
			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
			expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map([
				["outside", "[^outside]: Real definition."],
			]));
		}
	});

	it.each([
		["processing instruction", "<?target", "?>"],
		["declaration", "<!DOCTYPE html", ">"],
		["CDATA section", "<![CDATA[", "]]>"]
	])("keeps %s content opaque until its closing token", (_name, opening, closing) => {
		const source = [opening, "Hidden[^inside].", "[^inside]: Hidden.", closing].join("\n");

		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
		expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map());
	});

	it("lets a type-7 HTML block follow a definition without a paragraph", () => {
		const source = "[^real]: Actual definition.\n<widget>\n[^fake]: Raw HTML.\n</widget>";
		expect(footnotes.collectFootnoteDefinitions(source).has("fake")).toBe(false);
	});

	it("keeps a paragraph open through an indented lazy continuation", () => {
		const source = "Paragraph\n    lazy continuation\n<widget>\nVisible[^good].\n[^good]: Good.";
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		expect(footnotes.collectFootnoteDefinitions(source).get("good")).toBe("[^good]: Good.");
		expect(footnotes.hasFootnoteReferences("Paragraph\n    lazy reference[^good]")).toBe(true);
	});

	it.each(["#", "#\tHeading", "* * *", "_ _ _", "Heading\n===", "Heading\n---"])("keeps HTML after a completed block opaque: %s", (block) => {
		const source = block + "\n<widget>\nHidden[^bad].\n[^bad]: HTML";
		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
		expect(footnotes.collectFootnoteDefinitions(source).size).toBe(0);
	});

	it("keeps inline HTML and type-7 tags inside paragraphs Markdown-active", () => {
		expect(footnotes.hasFootnoteReferences("<span>Visible[^inline].</span>")).toBe(true);
		expect(footnotes.hasFootnoteReferences([
			"Paragraph continues",
			"<widget>",
			"Visible[^continuation].",
		].join("\n"))).toBe(true);
	});
});
