import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

interface FootnoteApi {
	hasFootnoteReferences: (markdown: string) => boolean;
	collectFootnoteDefinitions: (markdown: string) => Map<string, unknown>;
}

const require = createRequire(import.meta.url);
const footnotes = require("../src/footnotes.cjs") as FootnoteApi;

describe("footnote references in links", () => {
	it.each([
		"[docs](https://host/[^version])",
		"[docs](https://host/(release)/[^version])",
		"[docs](https://host/escaped\\)/[^version])",
		"[docs](<https://host/[^version]>)",
		"[docs](https://host/[^version] \"release title[^title]\")",
		"<https://host/[^version]>",
		"[docs]: https://host/[^version]",
		"[docs]: <https://host/[^version]>",
		"[docs]: https://host \"title[^version]\"",
		"[docs]: <https://host> 'title[^version]'",
		"[docs]: https://host (title[^version])",
	])("keeps link destinations opaque: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
	});

	it("keeps references in visible link labels and surrounding text", () => {
		expect(footnotes.hasFootnoteReferences("[docs[^note]](https://host/[^version])")).toBe(true);
		expect(footnotes.hasFootnoteReferences("[docs](https://host/[^version]) text[^note]")).toBe(true);
	});

	it("shields a comment opener inside a valid multiline inline-link title", () => {
		const source = "[docs](url \"title\ncontent<!--\") Visible[^note]. -->";

		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it("skips multiline-label discovery for a large paragraph of balanced footnote references", () => {
		const source = Array.from({ length: 3_000 }, (_, index) => `Line ${index} [^ref${index}]`).join("\n");

		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	}, 5_000);

	it("scans a large paragraph with unmatched brackets only once", () => {
		const source = Array.from({ length: 3_000 }, (_, index) => `Line ${index} [text`).join("\n");

		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
	}, 5_000);

	it("checks later multiline-label candidates after malformed nested metadata", () => {
		const source = "[valid [bad\nbad](broken trailing) valid](url/[^fake])";

		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
	});

	it("keeps definition syntax inside a multiline inline-link title opaque", () => {
		const source = [
			"[docs](url \"title",
			"[^fake]: attribute text",
			"end\") Visible[^real].",
		].join("\n");

		expect(footnotes.collectFootnoteDefinitions(source).has("fake")).toBe(false);
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it("keeps a next-line inline-link destination opaque", () => {
		const source = "[docs](\nurl \"title[^fake]\") Visible[^real].";

		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it("does not continue an inline link into a raw HTML block", () => {
		const source = "[docs](url \"title\n<!--\") Hidden[^note]. -->";

		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
	});

	it.each([
		"text](\nhttps://host/[^note])",
		"text](url \"title\n[^note]\")",
		"\\[text](\nhttps://host/[^note])",
	])("leaves references in malformed multiline links visible: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it.each([
		"Text <!-- [ --> text](\nhttps://host/[^note])",
		"Text %% [ %% text](\nhttps://host/[^note])",
		"Text <!-- [ --> text](https://host/[^note])",
		"Text %% [ %% text](https://host/[^note])",
	])("does not form a link from an opening label bracket hidden in a comment: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it.each([
		"[docs](https://host/[^note]",
		"[docs]\\(https://host/[^note])",
		"text](https://host/[^note])",
		"\\<https://host/[^note]>",
	])("leaves references in malformed links visible: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it("does not hide references after a link-definition destination", () => {
		expect(footnotes.hasFootnoteReferences("[docs]: target See [^note]")).toBe(true);
		expect(footnotes.hasFootnoteReferences("[^local]: See [^external]")).toBe(true);
		expect(footnotes.hasFootnoteReferences("[docs]: https://host \"title[^note]")).toBe(true);
		expect(footnotes.hasFootnoteReferences("[docs]: https://host \"title\" trailing[^note]")).toBe(true);
	});

	it.each([
		"[docs]: https://host \"Title\n[^fake]\nend\"",
		"[docs]: <https://host> 'Title\n[^fake]\nend'",
		"[docs]: https://host (Title\n[^fake]\nend)",
	])("keeps valid multiline link-definition titles opaque: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
	});

	it("keeps definition syntax inside every valid multiline reference title opaque", () => {
		const source = "[docs]: /url \"Title\n[^fake]: literal\nend\"";

		expect(footnotes.collectFootnoteDefinitions(source).has("fake")).toBe(false);
		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
	});

	it("keeps an HTML comment opener inside a valid reference-definition label opaque", () => {
		const source = "[docs <!--]: /url\nVisible[^note]\n-->";

		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it("uses the actual reference-label closer after an escaped bracket", () => {
		const source = "[docs \\]: <!--]: /url\nVisible[^note]\n-->";

		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it("keeps Obsidian comment syntax active inside a valid reference-definition label", () => {
		const source = "[docs %%]: /url\nHidden[^note]\n%%";

		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
	});

	it.each([
		["HTML", "[docs <!--]: <bad url>\nHidden[^note]\n-->"],
		["Obsidian", "[docs %%]: <bad url>\nHidden[^note]\n%%"],
	])("leaves comment syntax active in a malformed %s reference definition", (_name, source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
	});

	it.each([
		"[docs]:\n  https://host/[^fake]",
		"[docs]: https://host\n  \"title[^fake]\"",
		"[docs]:\n  https://host\n  \"title[^fake]\"",
		"[docs]:\n  <https://host>\n  'title[^fake]'",
	])("keeps next-line link-definition components opaque: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
	});

	it("detects references after a valid multiline link-definition title", () => {
		const source = "[docs]: https://host \"Title\n[^fake]\nend\"\n\nVisible[^real].";
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it.each([
		"[docs]: https://host \"Title\n[^real]",
		"[docs]: https://host \"Title\n\n[^real]\nend\"",
		"[docs]: https://host \"Title\nend\" trailing[^real]",
		"[docs]: https://host \"Title\n```\ncode\n```\nVisible[^real]\nend\"",
		"[docs]: https://host \"Title\n# Heading\nVisible[^real]\nend\"",
	])("leaves references beyond invalid multiline title boundaries visible: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it.each([
		"[docs]:\n  prose[^real] after destination",
		"[docs]:\n\n  https://host/[^real]",
		"[docs]: https://host\n  \"title\" trailing[^real]",
		"[docs]:\n  https://host\n# Heading\nVisible[^real]",
	])("keeps malformed or boundary-separated definition components visible: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it.each([
		"Paragraph\n[docs]: https://host/[^real]",
		"Paragraph\n[docs]:\n  https://host/[^real]",
	])("does not let a link reference definition interrupt a paragraph: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it.each([
		"Paragraph\n\n[docs]: https://host/[^fake]",
		"# Heading\n[docs]:\n  https://host/[^fake]",
	])("recognizes link reference definitions after block boundaries: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
	});

	it.each([
		"`x`[docs]: text[^note]",
		"`x`[docs]:\n  https://host/[^note]",
	])("validates a reference-definition prefix against original Markdown: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it.each([
		"[[Page[^version]]]",
		"![[Page[^version]]]",
		"[[Page#Heading[^version]]]",
		"[[Page\\|Literal[^version]]]",
		"[[Page[^fake]|Visible[^real]]]",
		"![[Page[^fake]|Caption[^real]]]",
	])("keeps complete wiki-link targets opaque: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
	});

	it("keeps references outside complete wiki links visible", () => {
		expect(footnotes.hasFootnoteReferences("[[Page[^fake]]] text[^real]")).toBe(true);
		expect(footnotes.hasFootnoteReferences("[[Page|Alias]] text[^real]")).toBe(true);
	});

	it.each([
		["HTML", "Text <!-- [[Page-->]] Visible[^note]. -->"],
		["Obsidian", "Text %% [[Page%%]] Visible[^note]. %%"],
		["multiline HTML", "Text <!--\n[[Page-->]] Visible[^note]. -->"],
		["multiline Obsidian", "Text %%\n[[Page%%]] Visible[^note]. %%"],
	])("does not hide a %s comment closer inside wiki-link-looking text", (_name, source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it.each([
		["HTML", "[[Page<!--]] Visible[^note]. -->"],
		["Obsidian", "[[Page%%]] Visible[^note]. %%"],
	])("shields a %s comment opener inside a complete wiki link", (_name, source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it.each([
		"Text <!-- [[Page[^fake]]]",
		"Text <!-- [docs](url/[^fake])",
	])("treats an unmatched HTML opener before valid link metadata as literal: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
	});

	it.each([
		["HTML", "Text <!-- <http://host/--> Visible[^note]. -->"],
		["Obsidian", "Text %% <http://host/%%> Visible[^note]. %%"],
	])("does not hide a %s comment closer inside autolink-looking text", (_name, source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it("treats an unmatched HTML opener before a valid autolink as literal", () => {
		expect(footnotes.hasFootnoteReferences("Text <!-- <http://host/[^fake]>")).toBe(false);
	});

	it("shields metadata after a soft-wrapped inline-link label", () => {
		const source = "[docs\nlabel](url \"<!--\") Visible[^note]. -->";

		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it("keeps a destination after a soft-wrapped label opaque", () => {
		expect(footnotes.hasFootnoteReferences("[docs\nlabel](url/[^fake])")).toBe(false);
	});

	it("keeps references in a soft-wrapped link label visible", () => {
		expect(footnotes.hasFootnoteReferences("[docs[^real]\nlabel](url/[^fake])")).toBe(true);
	});

	it("scopes paired comments to a soft-wrapped link label", () => {
		expect(footnotes.hasFootnoteReferences("[docs %% Hidden[^fake]\n%% label](url)")).toBe(false);
	});

	it.each([
		"[docs %% label\nmore](url/[^fake])",
		"[docs <!-- label\nmore](url/[^fake])",
	])("keeps an unmatched comment opener local to a soft-wrapped link label: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
	});

	it.each([
		"[docs\nlabel(url/[^real])",
		"\\[docs\nlabel](url/[^real])",
		"[docs\n\nlabel](url/[^real])",
		"[docs\n- label](url/[^real])",
		"[docs\n+\nlabel](url/[^real])",
		"[docs\n* \nlabel](url/[^real])",
		"[docs\n1. \nlabel](url/[^real])",
		"> [docs\n# label](url/[^real])",
	])("leaves malformed or container-broken soft-wrapped links visible: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});

	it("keeps a non-interrupting multi-digit list marker inside a soft-wrapped label", () => {
		expect(footnotes.hasFootnoteReferences("[docs\n01. Item\nlabel](url/[^fake])")).toBe(false);
	});

	it.each([
		"\\[[Page[^real]]]",
		"[[Page[^real]",
	])("leaves references in escaped or incomplete wiki links visible: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});
});

describe("native link-label delimiter precedence", () => {
	it.each(["[text <!-- ](url-->Visible[^real])", "[text %% ](url%%Visible[^real])"])("keeps the destination of a native valid link opaque: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
		expect(footnotes.hasFootnoteReferences(`${source} Outside[^real].`)).toBe(true);
	});

	it.each([
		"[text %% Hidden[^fake] %%](url)",
		"[text <!-- Hidden[^fake] -->](url)",
	])("keeps references inside paired link-label comments hidden: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(false);
	});

	it.each([
		"[text %% Visible[^real]](url)",
		"[text <!-- Visible[^real]](url)",
	])("keeps an unmatched link-label comment opener local: %s", (source) => {
		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		expect(footnotes.hasFootnoteReferences(`${source} Outside[^real].`)).toBe(true);
	});

	it("keeps an unmatched label comment opener local across a multiline destination", () => {
		const source = "[text %% Visible[^real]](\nurl) Outside[^outside].";

		expect(footnotes.hasFootnoteReferences(source)).toBe(true);
	});
});
