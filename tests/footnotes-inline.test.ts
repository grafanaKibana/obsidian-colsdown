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
});
