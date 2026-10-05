import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

interface FootnoteApi {
	collectFootnoteDefinitions: (source: string) => Map<string, string>;
	hasFootnoteReferences: (markdown: string) => boolean;
}

const require = createRequire(import.meta.url);
const footnotes = require("../src/footnotes.cjs") as FootnoteApi;

describe("footnote inline-code boundaries", () => {
	it("keeps references between escaped literal backticks visible", () => {
		expect(footnotes.hasFootnoteReferences("\\`Visible[^note].\\`")).toBe(true);
	});

	it("uses backslash parity when recognizing a code-span opener", () => {
		expect(footnotes.hasFootnoteReferences("\\\\`Hidden[^note].`")).toBe(false);
	});

	it("keeps references inside real code spans hidden", () => {
		expect(footnotes.hasFootnoteReferences("Before `Hidden[^note].` after")).toBe(false);
	});

	it("continues after an unmatched longer run to mask a later valid span", () => {
		expect(footnotes.hasFootnoteReferences("`` unmatched `Hidden[^note].`")).toBe(false);
	});

	it("lets a backslash-preceded closing delimiter close a real code span", () => {
		expect(footnotes.hasFootnoteReferences("`Hidden\\` Visible[^note].")).toBe(true);
	});

	it("uses the original prefix when a colon follows a reference", () => {
		expect(footnotes.hasFootnoteReferences("`x`[^note]: explanation")).toBe(true);
		expect(footnotes.collectFootnoteDefinitions("`x`[^note]: explanation").size).toBe(0);
	});

	it.each([
		"Text[^note]: explanation",
		"- Text[^note]: explanation",
		"> Text[^note]: explanation",
	])("keeps a prose reference followed by colon punctuation visible: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it.each([
		"[^note]: Definition.",
		"   [^note]: Definition.",
	])("does not treat a definition opener as a reference: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
	});

	it("detects a later reference in definition content", () => {
		expect(footnotes.hasFootnoteReferences("[^local]: See [^external]: explanation")).toBe(true);
	});

	it("accepts a colon-followed reference at the start of a table cell", () => {
		const source = [
			"Reference | Value",
			"--- | ---",
			"[^note]: explanation | Cell",
		].join("\n");

		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it("keeps definitions and references inside a multiline code span opaque", () => {
		const source = [
			"`literal",
			"Hidden[^fake].",
			"[^fake]: Not a definition.",
			"text`",
		].join("\n");

		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
		expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map());
	});

	it("masks multiline code spans inside a projected quote container", () => {
		const source = [
			"> `literal",
			"> Hidden[^fake].",
			"> [^fake]: Not a definition.",
			"> text`",
		].join("\n");

		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
		expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map());
	});

	it("keeps comment-only lines inside a multiline code span", () => {
		const source = [
			"`start",
			"%% literal %%",
			"[^fake]: Not a definition.",
			"end`",
		].join("\n");

		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
		expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map());
	});

	it("does not open a multiline span from a backtick hidden in a comment", () => {
		const source = [
			"%% `hidden %%",
			"Visible[^real].",
			"end`",
		].join("\n");

		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it("restores comment-masked text after a real multiline span closes", () => {
		const source = [
			"`start <!--",
			"end` Visible[^real].",
			"-->",
		].join("\n");

		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it("restores fenced-code boundaries after a multiline span contains a comment opener", () => {
		const source = [
			"`start <!--",
			"end`",
			"```text",
			"Hidden[^fake].",
			"```",
			"Visible[^real].",
		].join("\n");

		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it("reprojects a list fence after a code-contained percent comment opener", () => {
		const source = [
			"`start %%",
			"end`",
			"- ```text",
			"  Hidden[^fake].",
			"  ```",
		].join("\n");

		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
	});

	it("keeps a definition-looking line inside a native multiline code span", () => {
		const source = [
			"Text `literal",
			"[^local]: Definition.",
			"Visible[^external]",
			"text`",
		].join("\n");

		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
		expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map());
	});

	it("detects a reference after a multiline span closes", () => {
		expect(footnotes.hasFootnoteReferences("`literal\ntext` Visible[^real].")).toBe(true);
	});

	it("leaves an unmatched multiline opener literal", () => {
		expect(footnotes.hasFootnoteReferences("`literal\nVisible[^real].")).toBe(true);
	});

	it.each([
		"`literal\n\nVisible[^real].\ntext`",
		"`literal\n# Heading\nVisible[^real].\ntext`",
		"# Heading `literal\nVisible[^real].\ntext`",
	])("does not carry a code span across a block boundary", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});
});
