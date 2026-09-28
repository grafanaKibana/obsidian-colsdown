import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import Module from "node:module";
import * as ObsidianMock from "./obsidian.mock";

type Width = { kind: "auto" } | { kind: "percent" | "fraction"; value: number };
interface Item { width: Width; markdown: string }
interface ColsdownApi {
	CANONICAL_SEPARATOR: string;
	MAX_SEPARATOR_LENGTH: number;
	columnTracks: (items: Item[]) => string;
	isValidSeparator: (value: unknown) => boolean;
	layoutTemplate: (language: string, widths: string[], separator?: string) => string;
	normalizeSettings: (value?: Record<string, unknown>) => Record<string, unknown>;
	parseLayout: (source: string, direction?: string, separator?: string) => {
		direction: string;
		items: Item[];
	};
}

const require = createRequire(import.meta.url);
type ModuleLoader = (
	request: string,
	parent: unknown,
	isMain: boolean,
) => unknown;
const moduleInternals = Module as unknown as { _load: ModuleLoader };
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => (
	request === "obsidian"
		? ObsidianMock
		: originalLoad.call(Module, request, parent, isMain)
);
let ColsdownPlugin: ColsdownApi;
try {
	ColsdownPlugin = require("../src/main.cjs") as ColsdownApi;
} finally {
	moduleInternals._load = originalLoad;
}

const {
	CANONICAL_SEPARATOR,
	MAX_SEPARATOR_LENGTH,
	columnTracks,
	isValidSeparator,
	layoutTemplate,
	normalizeSettings,
	parseLayout,
} = ColsdownPlugin;

describe("Colsdown parser", () => {
	it("uses content before the first separator as the first column", () => {
		const parsed = parseLayout("First\n::: 70%\nSecond", "row");

		expect(parsed.items).toEqual([
			{ width: { kind: "auto" }, markdown: "First\n" },
			{ width: { kind: "percent", value: 70 }, markdown: "Second" },
		]);
    expect(columnTracks(parsed.items)).toBe("minmax(0, 30fr) minmax(0, 70fr)");
	});

	it("still accepts an explicit first marker", () => {
		const parsed = parseLayout("::: 25%\nLeft\n::: 75%\nRight", "row");

		expect(parsed.items[0]?.width).toEqual({ kind: "percent", value: 25 });
		expect(parsed.items[1]?.width).toEqual({ kind: "percent", value: 75 });
    expect(columnTracks(parsed.items)).toBe("minmax(0, 25fr) minmax(0, 75fr)");
	});

	it("locks a block to its first separator", () => {
		const parsed = parseLayout("One\n||| 40%\nTwo\n::: 10%\nStill two", "row", "|||");

		expect(parsed.items).toHaveLength(2);
		expect(parsed.items[1]?.markdown).toContain("::: 10%");
	});

	it("ignores separator-looking lines in nested fences", () => {
		const source = "First\n```text\n::: 5%\n```\n::: 60%\nSecond";
		const parsed = parseLayout(source, "row");

		expect(parsed.items).toHaveLength(2);
		expect(parsed.items[0]?.markdown).toContain("::: 5%");
		expect(parsed.items[1]?.width).toEqual({ kind: "percent", value: 60 });
	});

	it("keeps content opaque when no separator exists", () => {
		const source = "Only one item\nwith content";
		expect(parseLayout(source).items).toEqual([
			{ width: { kind: "auto" }, markdown: source },
		]);
	});
});

describe("templates and settings", () => {
	it("omits the inferable first marker in a 30/70 template", () => {
		expect(layoutTemplate("colsdown", ["30%", "70%"]))
			.toBe("```colsdown\nColumn 1\n\n::: 70%\nColumn 2\n```");
	});

	it("keeps stack item boundaries explicit", () => {
		expect(layoutTemplate("stack", ["", ""]))
			.toBe("```stack\n:::\nSection 1\n\n:::\nSection 2\n```");
	});

	it("bounds and sanitizes custom separators", () => {
		expect(isValidSeparator("x".repeat(MAX_SEPARATOR_LENGTH))).toBe(true);
		expect(isValidSeparator("x".repeat(MAX_SEPARATOR_LENGTH + 1))).toBe(false);
		expect(isValidSeparator("\u200b")).toBe(false);
		expect(isValidSeparator("~~~")).toBe(false);
		expect(normalizeSettings({ separator: "\u202e" }).separator).toBe(CANONICAL_SEPARATOR);
	});

	it("clamps numeric settings", () => {
		const settings = normalizeSettings({
			gapPx: 1000,
			minColumnWidthPx: 1,
			responsiveBreakpointPx: 9999,
			dividerWidthPx: 0,
		});

		expect(settings).toMatchObject({
			gapPx: 96,
			minColumnWidthPx: 80,
			responsiveBreakpointPx: 2000,
			dividerWidthPx: 1,
		});
	});
});
