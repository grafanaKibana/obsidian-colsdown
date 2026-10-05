import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

interface FootnoteApi {
	collectFootnoteDefinitions: (source: string) => Map<string, string>;
	hasFootnoteReferences: (source: string) => boolean;
}
const require = createRequire(import.meta.url);
const footnotes = require("../src/footnotes.cjs") as FootnoteApi;

describe("native named footnote labels", () => {
	it.each(["two words", "two\twords", " leading", "trailing ", " ", "\t", "two\\ words"])("rejects ASCII whitespace in label %s", (label) => {
		expect(footnotes.hasFootnoteReferences(`Text[^${label}]`)).toBe(false);
		expect(footnotes.collectFootnoteDefinitions(`[^${label}]: Literal prose.`)).toEqual(new Map());
	});

	it.each(["simple", "two-words_2.3", "two\u00a0words", "two\u2003words", "two\u202fwords", "two\u000cwords", "two\u000bwords", "\u00a0leading", "trailing\u00a0", "\u2003leading", "trailing\u2003", "two\\"])("preserves native-valid label %s", (label) => {
		const source = `[^${label}]: Native definition.`;
		expect(footnotes.hasFootnoteReferences(`Text[^${label}]`)).toBe(true);
		expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map([[label, source]]));
	});
});
