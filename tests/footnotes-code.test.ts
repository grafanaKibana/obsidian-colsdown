import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const footnotes = require("../src/footnotes.cjs") as {
	hasFootnoteReferences: (source: string) => boolean;
	collectFootnoteDefinitions: (source: string) => Map<string, string>;
};

describe("indented code opacity", () => {
	it.each(["    <!--", "\t<!--", "    %%", "\t%%"])("keeps comment text in code from hiding following prose: %s", (code) => {
		expect(footnotes.hasFootnoteReferences(`${code}\nVisible[^note]\n-->`)).toBe(true);
	});

	it("does not collect definitions inside an indented comment-shaped code block", () => {
		const source = "    <!--\n    [^fake]: code\n    -->\nVisible[^note]\n\n[^note]: Real definition.";
		expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map([["note", "[^note]: Real definition."]]));
	});

	it("keeps an indented continuation in an established paragraph", () => {
		expect(footnotes.hasFootnoteReferences("Paragraph\n    Visible[^note]")).toBe(true);
	});

	it("starts opaque indented code after a blank paragraph boundary", () => {
		expect(footnotes.hasFootnoteReferences("Paragraph\n\n    <!--\nVisible[^note]\n-->")).toBe(true);
	});
});

describe("closed heading comment boundaries", () => {
	it.each(["", "    code\n"])("does not carry an unmatched heading comment into following Markdown: %s", (code) => {
		expect(footnotes.hasFootnoteReferences(`# Heading <!--\n${code}Visible[^real]\n-->`)).toBe(true);
	});
	it("keeps a complete same-line heading comment opaque", () => {
		expect(footnotes.hasFootnoteReferences("# Heading <!-- Hidden[^real] -->")).toBe(false);
	});
});
