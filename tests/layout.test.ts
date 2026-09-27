import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";
const require = createRequire(import.meta.url);
interface LayoutApi {
 validateWidths(this: void, input: string): { widths: string[]; error: string | null };
 columnTracks(this: void, items: unknown[]): string;
 parseLayout(this: void, source: string): { items: unknown[] };
}
const { validateWidths, columnTracks, parseLayout } = require("../src/layout.cjs") as LayoutApi;

describe("validated layouts", () => {
	it.each(["auto, auto", "30%, 70%", "1fr, 2fr", "auto, 30%, 2fr", "0.5%, 99.5%"])("accepts %s", (value) => {
		expect(validateWidths(value).error).toBeNull();
	});
	it.each(["", "30%, 30%", "100%, auto", "0fr, auto", "-2fr, auto", "NaN%, auto", "20px, auto"])("rejects %s", (value) => {
		expect(validateWidths(value).error).toBeTruthy();
	});
	it("uses fractions of usable space so mixed units cannot add gaps to percentages", () => {
		expect(columnTracks(parseLayout("A\n::: 50%\nB\n::: 2fr\nC").items))
			.toBe("minmax(0, 16.666666666666668fr) minmax(0, 50fr) minmax(0, 33.333333333333336fr)");
	});
  it("lets automatic columns fit below the preferred minimum width", () => {
		expect(columnTracks(parseLayout("A\n:::\nB").items)).toContain("min(100%, var(--layout-min-width))");
  });
  it.each(["A\n::: 100%\nB", "::: 90%\nA\n::: 90%\nB\n:::\nC", "::: 100%\nA\n::: 2fr\nB"])("keeps every malformed mixed-width column visible: %s", (source) => {
    const items = parseLayout(source).items;
    expect(columnTracks(items)).toBe(items.map(() => "minmax(0, 1fr)").join(" "));
  });
});
