import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

interface FootnoteApi {
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

	it("lets a backslash-preceded closing delimiter close a real code span", () => {
		expect(footnotes.hasFootnoteReferences("`Hidden\\` Visible[^note].")).toBe(true);
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
});
