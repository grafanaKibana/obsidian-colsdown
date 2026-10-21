import { createRequire } from "node:module";
import Module from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import * as ObsidianMock from "./obsidian.mock";

const loadModule = createRequire(import.meta.url);
const moduleInternals = Module as unknown as {
	_load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
function require(request: string): unknown {
	const original = moduleInternals._load;
	moduleInternals._load = (id, parent, isMain) => id === "obsidian"
		? ObsidianMock : original.call(Module, id, parent, isMain);
	try { return loadModule(request); }
	finally { moduleInternals._load = original; }
}

//#region Fenced layouts

describe("Fenced parser and templates", () => {
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

	let ColsdownPlugin: ColsdownApi;

		ColsdownPlugin = require("../src/main.cjs") as ColsdownApi;

	const {
		columnTracks,
		layoutTemplate,
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

	describe("Fenced templates", () => {
		it("omits the inferable first marker in a 30/70 template", () => {
			expect(layoutTemplate("colsdown", ["30%", "70%"]))
				.toBe("```colsdown\nColumn 1\n\n::: 70%\nColumn 2\n```");
		});

		it("keeps stack item boundaries explicit", () => {
			expect(layoutTemplate("stack", ["", ""]))
				.toBe("```stack\n:::\nSection 1\n\n:::\nSection 2\n```");
		});

	});
});

describe("Fenced source edits", () => {
	interface FenceCandidate {
		body: string;
		bodyEnd: number;
		bodyStart: number;
		depth: number;
		language: string;
		lineEnd: number;
		lineStart: number;
	}

	interface SourceEditsApi {
		commitAddedColumn: (
			app: TestApp,
			prepared: Record<string, unknown>,
			separator?: string,
		) => Promise<{ source: string; changed: boolean; authority?: string }>;
		commitWidths: (
			app: TestApp,
			prepared: Record<string, unknown>,
			percentages: number[],
			separator?: string,
		) => Promise<{ source: string; changed: boolean; authority?: string }>;
		normalizeRenderedBody: (source: string) => string;
		prepareSourceEdit: (
			app: TestApp,
			context: TestContext,
			element: HTMLElement,
			source: string,
			separator: string,
		) => Promise<Record<string, unknown>>;
		rewriteLayoutWidths: (source: string, percentages: number[], separator: string) => string;
		scanLayoutFences: (source: string) => FenceCandidate[];
		selectLayoutFence: (
			snapshot: string,
			source: string,
			section: { lineStart: number; lineEnd: number } | null,
		) => FenceCandidate;
	}

	interface LayoutApi {
		columnTracks: (items: Array<{ width: { kind: string; value?: number } }>) => string;
		parseLayout: (source: string, direction?: string, separator?: string) => {
			items: Array<{ width: { kind: string; value?: number } }>;
		};
	}

	interface TestEditor {
		getValue: () => string;
		offsetToPos?: (offset: number) => { line: number; ch: number };
		replaceRange?: ReturnType<typeof vi.fn>;
		transaction?: ReturnType<typeof vi.fn>;
	}

	interface TestView {
		file: TestFile;
		getMode: () => "source" | "preview";
		editor: TestEditor;
	}

	interface TestFile { path: string }

	interface TestApp {
		vault: {
			getAbstractFileByPath: (path: string) => TestFile | null;
			read: ReturnType<typeof vi.fn>;
			process: ReturnType<typeof vi.fn>;
		};
		workspace: {
			getLeavesOfType: ReturnType<typeof vi.fn>;
		};
	}

	interface TestContext {
		sourcePath: string;
		getSectionInfo: ReturnType<typeof vi.fn>;
	}

	const api = require("../src/source-edits.cjs") as SourceEditsApi;

	const layoutApi = require("../src/layout.cjs") as LayoutApi;

	const {
		commitAddedColumn,
		commitWidths,
		normalizeRenderedBody,
		prepareSourceEdit,
		rewriteLayoutWidths,
		scanLayoutFences,
		selectLayoutFence,
	} = api;

	const { columnTracks, parseLayout } = layoutApi;

	const body = "Left\n::: 70%\nRight";

	const note = `Before\n\n\`\`\`colsdown\n${body}\n\`\`\`\n\nAfter`;

	function editor(value: () => string): TestEditor {
		return {
			getValue: value,
			offsetToPos: (offset) => ({ line: 0, ch: offset }),
			transaction: vi.fn(),
		};
	}

	function view(file: TestFile, sourceEditor: TestEditor, mode: "source" | "preview" = "source"): TestView {
		return { file, editor: sourceEditor, getMode: () => mode };
	}

	function harness(initial = note, views: TestView[] = []): {
		app: TestApp;
		context: TestContext;
		file: TestFile;
		getDisk: () => string;
		setDisk: (value: string) => void;
	} {
		const file = views[0]?.file ?? { path: "Note.md" };
		let disk = initial;
		const app: TestApp = {
			vault: {
				getAbstractFileByPath: (path) => path === file.path ? file : null,
				read: vi.fn(async () => disk),
				process: vi.fn(async (_file: TestFile, transform: (source: string) => string) => {
					disk = transform(disk);
				}),
			},
			workspace: {
				getLeavesOfType: vi.fn(() => views.map((markdownView) => ({ view: markdownView }))),
			},
		};
		return {
			app,
			context: {
				sourcePath: file.path,
				getSectionInfo: vi.fn(() => ({ text: note, lineStart: 2, lineEnd: 6 })),
			},
			file,
			getDisk: () => disk,
			setDisk: (value) => { disk = value; },
		};
	}

	describe("source fence mapping", () => {
		it("normalizes only line endings and one renderer trailing newline", () => {
			expect(normalizeRenderedBody("A\r\nB\r\n")).toBe("A\nB");
			expect(normalizeRenderedBody("A\nB\n\n")).toBe("A\nB\n");
		});

		it("scans tilde and long layout fences while skipping code examples", () => {
			const source = [
				"````text",
				"```colsdown",
				"Fake",
				"```",
				"````",
				"~~~~colsdown extra",
				"Real",
				"~~~~",
			].join("\n");
			const candidates = scanLayoutFences(source);

			expect(candidates).toHaveLength(1);
			expect(candidates[0]).toMatchObject({ language: "colsdown", body: "Real\n" });
		});

		it("recurses into layout bodies for nested layouts", () => {
			const source = [
				"````colsdown",
				"Outer",
				"```stack",
				"Inner",
				"```",
				"::: 50%",
				"Other",
				"````",
			].join("\n");
			const candidates = scanLayoutFences(source);

			expect(candidates.map(({ language, depth }) => ({ language, depth }))).toEqual([
				{ language: "colsdown", depth: 0 },
				{ language: "stack", depth: 1 },
			]);
		});

		it("uses exact section boundaries to disambiguate identical siblings", () => {
			const fence = "```colsdown\nLeft\n::: 70%\nRight\n```";
			const snapshot = `${fence}\nGap\n${fence}`;
			const selected = selectLayoutFence(snapshot, body, { lineStart: 6, lineEnd: 10 });

			expect(selected.lineStart).toBe(6);
		});

		it("rejects duplicate bodies without an exact section match", () => {
			const fence = "```colsdown\nLeft\n::: 70%\nRight\n```";
			expect(() => selectLayoutFence(`${fence}\n${fence}`, body, null))
				.toThrow(/multiple identical layout fences/i);
		});

		it("never selects a stack fence that shares a column body", () => {
			const stack = "```stack\nLeft\n::: 70%\nRight\n```";
			const columns = "```colsdown\nLeft\n::: 70%\nRight\n```";
			expect(selectLayoutFence(`${stack}\n${columns}`, body, null).language).toBe("colsdown");
			expect(() => selectLayoutFence(stack, body, null)).toThrow(/no longer has an exact fenced source match/i);
		});
	});

	describe("width serialization", () => {
		it("inserts the implicit first marker and rewrites every width", () => {
			expect(rewriteLayoutWidths(body, [35, 65], ":::"))
				.toBe("::: 35%\nLeft\n::: 65%\nRight");
		});

		it("canonicalizes mixed units and preserves marker spacing", () => {
			const source = ":::   1fr  \nA\n::: 50%\nB\n::: auto\nC";
			expect(rewriteLayoutWidths(source, [30, 45, 25], ":::"))
				.toBe(":::   30%  \nA\n::: 45%\nB\n::: 25%\nC");
		});

		it("preserves custom separators, CRLF, and sub-one-percent widths", () => {
			const source = "One\r\n||| 40%\r\nTwo";
			expect(rewriteLayoutWidths(source, [0.5, 99.5], "|||"))
				.toBe("||| 0.5%\r\nOne\r\n||| 99.5%\r\nTwo");
		});

		it("preserves nested code and changes marker lines only", () => {
			const source = "A\n```text\n::: 5%\n```\n::: 60%\nB";
			expect(rewriteLayoutWidths(source, [40, 60], ":::"))
				.toBe("::: 40%\nA\n```text\n::: 5%\n```\n::: 60%\nB");
		});

		it("rejects invalid vectors", () => {
			expect(() => rewriteLayoutWidths(body, [0, 100], ":::"))
				.toThrow(/greater than 0/i);
			expect(() => rewriteLayoutWidths(body, [0.00001, 99.99999], ":::"))
				.toThrow(/after rounding/i);
			expect(() => rewriteLayoutWidths(body, [40, 50], ":::"))
				.toThrow(/add up to 100/i);
		});
	});

	describe("adding an automatic column", () => {
		it("reserves an equal share for an auto column while preserving explicit percentage ratios", async () => {
			const explicitBody = "::: 30%\nFirst\n::: 70%\nSecond";
			const explicitNote = `\`\`\`colsdown\n${explicitBody}\n\`\`\``;
			const state = harness(explicitNote);
			const prepared = await prepareSourceEdit(
				state.app,
				state.context,
				document.body,
				explicitBody,
				"|||",
			);

			const result = await commitAddedColumn(state.app, prepared);
			const parsed = parseLayout(result.source, "row", ":::");

			expect(result).toMatchObject({
				source: "::: 20%\nFirst\n::: 46.6667%\nSecond\n:::\nNew column\n",
				changed: true,
				authority: "vault",
			});
			expect(parsed.items.map((item) => item.width)).toEqual([
				{ kind: "percent", value: 20 },
				{ kind: "percent", value: 46.6667 },
				{ kind: "auto" },
			]);
			expect(columnTracks(parsed.items)).toBe(
				"minmax(0, 20fr) minmax(0, 46.6667fr) minmax(0, 33.33330000000001fr)",
			);
			expect(state.getDisk()).toBe(
				"```colsdown\n::: 20%\nFirst\n::: 46.6667%\nSecond\n:::\nNew column\n```",
			);
		});

		it("normalizes handwritten percentage totals and preserves custom marker formatting", async () => {
			const explicitBody = "|||   10%  \r\nFirst\r\n||| 20%\r\nSecond";
			const explicitNote = `~~~~colsdown\r\n${explicitBody}\r\n~~~~`;
			const state = harness(explicitNote);
			const prepared = await prepareSourceEdit(
				state.app,
				state.context,
				document.body,
				explicitBody,
				"|||",
			);

			const result = await commitAddedColumn(state.app, prepared);
			const parsed = parseLayout(result.source, "row", "|||");

			expect(result.source).toBe(
				"|||   22.2222%  \r\nFirst\r\n||| 44.4444%\r\nSecond\r\n|||\r\nNew column\r\n",
			);
			expect(parsed.items.map((item) => item.width)).toEqual([
				{ kind: "percent", value: 22.2222 },
				{ kind: "percent", value: 44.4444 },
				{ kind: "auto" },
			]);
			expect(columnTracks(parsed.items)).toBe(
				"minmax(0, 22.2222fr) minmax(0, 44.4444fr) minmax(0, 33.3334fr)",
			);
		});

		it("rejects a percentage ratio that would round a column to zero", async () => {
			const explicitBody = "::: 0.00001%\nFirst\n::: 99.99999%\nSecond";
			const explicitNote = `\`\`\`colsdown\n${explicitBody}\n\`\`\``;
			const state = harness(explicitNote);
			const prepared = await prepareSourceEdit(
				state.app,
				state.context,
				document.body,
				explicitBody,
				":::",
			);

			await expect(commitAddedColumn(state.app, prepared)).rejects.toThrow(/after rounding/i);
			expect(state.app.vault.process).not.toHaveBeenCalled();
			expect(state.getDisk()).toBe(explicitNote);
		});

		it("follows a custom separator lock and preserves implicit content", async () => {
			const customBody = "First\n||| 2fr\nSecond";
			const customNote = `\`\`\`colsdown\n${customBody}\n\`\`\``;
			const state = harness(customNote);
			const prepared = await prepareSourceEdit(
				state.app,
				state.context,
				document.body,
				customBody,
				"|||",
			);

			await expect(commitAddedColumn(state.app, prepared))
				.resolves.toMatchObject({ source: `${customBody}\n|||\nNew column\n`, changed: true });
			expect(state.getDisk()).toBe(`\`\`\`colsdown\n${customBody}\n|||\nNew column\n\`\`\``);
		});

		it("preserves an existing empty column", async () => {
			const emptyColumnBody = "First\n:::\n:::\nFourth";
			const emptyColumnNote = `\`\`\`colsdown\n${emptyColumnBody}\n\`\`\``;
			const state = harness(emptyColumnNote);
			const prepared = await prepareSourceEdit(
				state.app,
				state.context,
				document.body,
				emptyColumnBody,
				":::",
			);

			await expect(commitAddedColumn(state.app, prepared))
				.resolves.toMatchObject({ source: `${emptyColumnBody}\n:::\nNew column\n`, changed: true });
		});

		it.each([
			{ label: "unmarked", body: "Only column", expected: "Only column\n:::\nNew column\n" },
			{ label: "empty", body: "", expected: ":::\n:::\nNew column\n" },
			{ label: "whitespace-only", body: " \t", expected: " \t\n:::\n:::\nNew column\n" },
		])("adds one parsed column to a $label layout", async ({ body: source, expected }) => {
			const sourceNote = `\`\`\`colsdown\n${source}${source === "" ? "" : "\n"}\`\`\``;
			const state = harness(sourceNote);
			const prepared = await prepareSourceEdit(
				state.app,
				state.context,
				document.body,
				source,
				":::",
			);

			const result = await commitAddedColumn(state.app, prepared);

			expect(result.source).toBe(expected);
			expect(state.app.vault.process).toHaveBeenCalledTimes(1);
		});

		it("preserves CRLF and ignores separators inside a closed nested fence", async () => {
			const nestedBody = "First\r\n```text\r\n::: 5%\r\n```\r\nSecond";
			const nestedNote = `Heading\r\n~~~~colsdown\r\n${nestedBody}\r\n~~~~\r\nTail`;
			const state = harness(nestedNote);
			const prepared = await prepareSourceEdit(
				state.app,
				state.context,
				document.body,
				nestedBody,
				":::",
			);

			await commitAddedColumn(state.app, prepared);

			expect(state.getDisk()).toBe(
				`Heading\r\n~~~~colsdown\r\n${nestedBody}\r\n:::\r\nNew column\r\n~~~~\r\nTail`,
			);
		});

		it("rejects an unclosed nested fence when the marker would remain code", async () => {
			const malformedBody = "First\n```text\ncode";
			const malformedNote = `\`\`\`\`colsdown\n${malformedBody}\n\`\`\`\``;
			const state = harness(malformedNote);
			const prepared = await prepareSourceEdit(
				state.app,
				state.context,
				document.body,
				malformedBody,
				":::",
			);

			await expect(commitAddedColumn(state.app, prepared)).rejects.toThrow(/nested code fences/i);
			expect(state.app.vault.process).not.toHaveBeenCalled();
			expect(state.getDisk()).toBe(malformedNote);
		});

		it("uses one editor transaction and rejects a stale editor snapshot", async () => {
			const file = { path: "Note.md" };
			let current = note;
			const sourceEditor = editor(() => current);
			const state = harness(note, [view(file, sourceEditor)]);
			const prepared = await prepareSourceEdit(state.app, state.context, document.body, body, ":::");

			await expect(commitAddedColumn(state.app, prepared))
				.resolves.toMatchObject({ authority: "editor", changed: true });
			expect(sourceEditor.transaction).toHaveBeenCalledTimes(1);
			expect(state.app.vault.process).not.toHaveBeenCalled();

			current = `${note}\nConcurrent edit`;
			await expect(commitAddedColumn(state.app, prepared)).rejects.toThrow(/note changed/i);
			expect(sourceEditor.transaction).toHaveBeenCalledTimes(1);
		});

		it("rejects a stale vault snapshot without writing", async () => {
			const state = harness();
			const prepared = await prepareSourceEdit(state.app, state.context, document.body, body, ":::");
			state.setDisk(`${note}\nConcurrent edit`);

			await expect(commitAddedColumn(state.app, prepared)).rejects.toThrow(/note changed/i);
			expect(state.getDisk()).toBe(`${note}\nConcurrent edit`);
		});
	});

	describe("source authority and saving", () => {
		it("uses an inactive source leaf and performs one editor transaction", async () => {
			const file = { path: "Note.md" };
			const sourceEditor = editor(() => note);
			const readingEditor = editor(() => "dormant stale buffer");
			const state = harness(note, [
				view(file, readingEditor, "preview"),
				view(file, sourceEditor),
			]);
			const prepared = await prepareSourceEdit(state.app, state.context, document.body, body, ":::");
			const result = await commitWidths(state.app, prepared, [35, 65]);

			expect(result).toMatchObject({ authority: "editor", changed: true });
			expect(sourceEditor.transaction).toHaveBeenCalledTimes(1);
			expect(readingEditor.transaction).not.toHaveBeenCalled();
			expect(state.app.vault.read).not.toHaveBeenCalled();
			expect(state.app.vault.process).not.toHaveBeenCalled();
		});

		it("rejects identical text in multiple source panes without editing either", async () => {
			const file = { path: "Note.md" };
			const first = editor(() => note);
			const second = editor(() => note);
			const state = harness(note, [view(file, first), view(file, second)]);

			await expect(prepareSourceEdit(state.app, state.context, document.body, body, ":::"))
				.rejects.toThrow(/close the extra source panes/i);
			expect(first.transaction).not.toHaveBeenCalled();
			expect(second.transaction).not.toHaveBeenCalled();
			expect(state.app.vault.read).not.toHaveBeenCalled();
			expect(state.app.vault.process).not.toHaveBeenCalled();
		});

		it("rejects divergent source buffers without reading or writing the vault", async () => {
			const file = { path: "Note.md" };
			const state = harness(note, [
				view(file, editor(() => note)),
				view(file, editor(() => `${note}\nchanged`)),
			]);

			await expect(prepareSourceEdit(state.app, state.context, document.body, body, ":::"))
				.rejects.toThrow(/close the extra source panes/i);
			expect(state.app.vault.read).not.toHaveBeenCalled();
			expect(state.app.vault.process).not.toHaveBeenCalled();
		});

		it("rejects an extra source pane that appears before commit", async () => {
			const file = { path: "Note.md" };
			const first = editor(() => note);
			const second = editor(() => note);
			const views = [view(file, first)];
			const state = harness(note, views);
			const prepared = await prepareSourceEdit(state.app, state.context, document.body, body, ":::");
			views.push(view(file, second));

			await expect(commitWidths(state.app, prepared, [35, 65]))
				.rejects.toThrow(/close the extra source panes/i);
			expect(first.transaction).not.toHaveBeenCalled();
			expect(second.transaction).not.toHaveBeenCalled();
			expect(state.app.vault.process).not.toHaveBeenCalled();
		});

		it("uses one atomic vault process when no source editor exists", async () => {
			const state = harness();
			const prepared = await prepareSourceEdit(state.app, state.context, document.body, body, ":::");
			const result = await commitWidths(state.app, prepared, [35, 65]);

			expect(result.source).toBe("::: 35%\nLeft\n::: 65%\nRight\n");
			expect(state.app.vault.process).toHaveBeenCalledTimes(1);
			expect(state.getDisk()).toBe("Before\n\n```colsdown\n::: 35%\nLeft\n::: 65%\nRight\n```\n\nAfter");
		});

		it("preserves a CRLF note and its long fence outside marker edits", async () => {
			const crlfBody = "Left\r\n::: 70%\r\nRight";
			const crlfNote = `Heading\r\n~~~~colsdown\r\n${crlfBody}\r\n~~~~\r\nTail`;
			const state = harness(crlfNote);
			state.context.getSectionInfo.mockReturnValue({ text: crlfNote, lineStart: 1, lineEnd: 5 });
			const prepared = await prepareSourceEdit(
				state.app,
				state.context,
				document.body,
				"Left\n::: 70%\nRight",
				":::",
			);

			await commitWidths(state.app, prepared, [35, 65]);
			expect(state.getDisk()).toBe(
				"Heading\r\n~~~~colsdown\r\n::: 35%\r\nLeft\r\n::: 65%\r\nRight\r\n~~~~\r\nTail",
			);
		});

		it("rejects a stale vault snapshot without changing current content", async () => {
			const state = harness();
			const prepared = await prepareSourceEdit(state.app, state.context, document.body, body, ":::");
			state.setDisk(`${note}\nConcurrent edit`);

			await expect(commitWidths(state.app, prepared, [35, 65])).rejects.toThrow(/note changed/i);
			expect(state.getDisk()).toBe(`${note}\nConcurrent edit`);
		});

		it("rechecks source-editor authority inside the vault transaction", async () => {
			const views: TestView[] = [];
			const state = harness(note, views);
			const prepared = await prepareSourceEdit(state.app, state.context, document.body, body, ":::");
			state.app.vault.process.mockImplementationOnce((
				_file: TestFile,
				transform: (source: string) => string,
			) => {
				views.push(view(state.file, editor(() => note)));
				transform(note);
			});

			await expect(commitWidths(state.app, prepared, [35, 65]))
				.rejects.toThrow(/editing mode changed/i);
			expect(state.getDisk()).toBe(note);
		});

		it("rejects extra source panes that appear inside the vault transaction", async () => {
			const views: TestView[] = [];
			const state = harness(note, views);
			const prepared = await prepareSourceEdit(state.app, state.context, document.body, body, ":::");
			const first = editor(() => note);
			const second = editor(() => note);
			state.app.vault.process.mockImplementationOnce((
				_file: TestFile,
				transform: (source: string) => string,
			) => {
				views.push(view(state.file, first), view(state.file, second));
				transform(note);
			});

			await expect(commitWidths(state.app, prepared, [35, 65]))
				.rejects.toThrow(/close the extra source panes/i);
			expect(first.transaction).not.toHaveBeenCalled();
			expect(second.transaction).not.toHaveBeenCalled();
			expect(state.getDisk()).toBe(note);
		});

		it("rechecks note identity inside the vault transaction", async () => {
			const state = harness();
			const prepared = await prepareSourceEdit(state.app, state.context, document.body, body, ":::");
			const replacement = { path: "Note.md" };
			state.app.vault.process.mockImplementationOnce((
				_file: TestFile,
				transform: (source: string) => string,
			) => {
				state.app.vault.getAbstractFileByPath = () => replacement;
				transform(note);
			});

			await expect(commitWidths(state.app, prepared, [35, 65]))
				.rejects.toThrow(/identity changed/i);
			expect(state.getDisk()).toBe(note);
		});

		it("rejects editor changes and authority changes during the gesture", async () => {
			const file = { path: "Note.md" };
			let current = note;
			const sourceEditor = editor(() => current);
			const views = [view(file, sourceEditor)];
			const state = harness(note, views);
			const prepared = await prepareSourceEdit(state.app, state.context, document.body, body, ":::");
			current = `${note}\nConcurrent edit`;

			await expect(commitWidths(state.app, prepared, [35, 65])).rejects.toThrow(/note changed/i);
			expect(sourceEditor.transaction).not.toHaveBeenCalled();

			current = note;
			views.length = 0;
			await expect(commitWidths(state.app, prepared, [35, 65])).rejects.toThrow(/editing mode changed/i);
			expect(state.app.vault.process).not.toHaveBeenCalled();
		});

		it("rejects a renamed or replaced note identity", async () => {
			const state = harness();
			const prepared = await prepareSourceEdit(state.app, state.context, document.body, body, ":::");
			state.file.path = "Renamed.md";

			await expect(commitWidths(state.app, prepared, [35, 65])).rejects.toThrow(/unavailable or was renamed/i);
			expect(state.app.vault.process).not.toHaveBeenCalled();
		});

		it("does not write when serialization produces no change", async () => {
			const explicitBody = "::: 35%\nLeft\n::: 65%\nRight";
			const explicitNote = `\`\`\`colsdown\n${explicitBody}\n\`\`\``;
			const state = harness(explicitNote);
			state.context.getSectionInfo.mockReturnValue({ text: explicitNote, lineStart: 0, lineEnd: 4 });
			const prepared = await prepareSourceEdit(
				state.app,
				state.context,
				document.body,
				explicitBody,
				":::",
			);

			await expect(commitWidths(state.app, prepared, [35, 65]))
				.resolves.toMatchObject({ source: `${explicitBody}\n`, changed: false });
			expect(state.app.vault.process).not.toHaveBeenCalled();
		});

		it("still rejects a stale snapshot when the requested widths are unchanged", async () => {
			const explicitBody = "::: 35%\nLeft\n::: 65%\nRight";
			const explicitNote = `\`\`\`colsdown\n${explicitBody}\n\`\`\``;
			const state = harness(explicitNote);
			state.context.getSectionInfo.mockReturnValue({ text: explicitNote, lineStart: 0, lineEnd: 4 });
			const prepared = await prepareSourceEdit(
				state.app,
				state.context,
				document.body,
				explicitBody,
				":::",
			);
			state.setDisk(`${explicitNote}\nConcurrent edit`);

			await expect(commitWidths(state.app, prepared, [35, 65])).rejects.toThrow(/note changed/i);
			expect(state.app.vault.process).not.toHaveBeenCalled();
		});

		it("propagates vault write rejection without changing the prepared source", async () => {
			const state = harness();
			const prepared = await prepareSourceEdit(state.app, state.context, document.body, body, ":::");
			state.app.vault.process.mockRejectedValueOnce(new Error("disk full"));

			await expect(commitWidths(state.app, prepared, [35, 65])).rejects.toThrow("disk full");
			expect(state.getDisk()).toBe(note);
		});
	});
});

//#endregion

//#region Marker layouts

describe("Marker parser and templates", () => {
	type Item = { width: { kind: string; value?: number }; markdown: string };

	type Region = { start: number; end: number; depth: number; body: string; lineStart: number; lineEnd: number; direction: string };

	const { scanMarkerLayouts, parseMarkerLayout } = require("../src/markers.cjs") as {
	  scanMarkerLayouts: (source: string) => Region[];
	  parseMarkerLayout: (source: string, direction?: string) => { direction: string; items: Item[]; markers: { start: number; end: number; bodyStart: number; line: string; implicit?: boolean }[]; separator: string };
	};

	const { parseLayout, parseLayoutSource, layoutTemplate, columnTracks, normalizeWidth } = require("../src/layout.cjs") as {
	  parseLayout: (source: string) => { items: Item[] };
	  parseLayoutSource: (source: string, direction: string, separator: string, syntax: string) => { items: Item[] };
	  columnTracks: (items: Item[]) => string;
	  normalizeWidth: (width: string) => Item["width"];
	  layoutTemplate: (language: string, widths: string[], separator: string, syntax: string) => string;
	};

	const wrap = (body: string, meta = "") => `%% col-start${meta} %%\n${body}\n%% col-end %%`;

	describe("marker layouts", () => {
	  it("parses first break as first column and ignores prelude", () => {
	    const source = wrap("ignored prelude\n%% col-break:40 %%\nLeft\n%% col-break:w:2fr %%\nRight");
	    const parsed = parseMarkerLayout(source);
	    expect(parsed.items).toEqual([
	      { width: { kind: "percent", value: 40 }, markdown: "Left\n" },
	      { width: { kind: "fraction", value: 2 }, markdown: "Right\n" },
	    ]);
	    expect(source.slice(parsed.markers[0]!.start, parsed.markers[0]!.end)).toBe("%% col-break:40 %%");
	  });
	  it.each([
	    ["40", { kind: "percent", value: 40 }],
	    ["25.5%", { kind: "percent", value: 25.5 }],
	    ["2fr", { kind: "fraction", value: 2 }],
	    ["auto", { kind: "auto" }],
	  ])("reads direct and legacy width token %s identically", (token, width) => {
	    for (const prefix of [":", ":w:"]) {
	      const source = wrap(`%% col-break${prefix}${token}:unknown:99 %%\nText`);
	      expect(parseMarkerLayout(source).items).toEqual([{ width, markdown: "Text\n" }]);
	    }
	  });
	  it("parses compact columns and stack metadata while retaining explicit first-column semantics", () => {
	    const source = "%% cols %%\n \t\n%% col:40 %%\nLeft\n%% col:2fr %%\nRight\n%% endcols %%";
	    const parsed = parseMarkerLayout(source);
	    expect(parsed.items).toEqual([
	      { width: { kind: "percent", value: 40 }, markdown: "Left\n" },
	      { width: { kind: "fraction", value: 2 }, markdown: "Right\n" },
	    ]);
	    expect(parsed.separator).toBe("%% col %%");
	    expect(parseMarkerLayout(wrap("%% col-break %%\nLegacy")).separator).toBe("%% col-break %%");
	    for (const metadata of [":stack", ":l:stack"]) {
	      expect(parseMarkerLayout(source.replace("%% cols %%", `%% cols${metadata} %%`)).direction).toBe("column");
	    }
	    for (const invalid of ["%% cols %%\n%% col %%\nUnclosed", "Text %% cols %%\n%% col %%\nText\n%% endcols %%"]) {
	      expect(scanMarkerLayouts(invalid)).toEqual([]);
	      expect(parseMarkerLayout(invalid).items[0]!.markdown).toBe(invalid);
	    }
	  });
	  it("uses compact opener content as an implicit first column with exact CRLF bounds", () => {
	    const source = "%% cols:unknown %%\r\nLeft\r\n%% col:60 %%\r\nRight\r\n%% endcols %%";
	    const parsed = parseMarkerLayout(source);
	    expect(parsed.items).toEqual([
	      { width: { kind: "auto" }, markdown: "Left\r\n" },
	      { width: { kind: "percent", value: 60 }, markdown: "Right\r\n" },
	    ]);
	    expect(parsed.markers[0]).toEqual({ implicit: true, start: 0, end: 18, bodyStart: 20, line: "%% cols:unknown %%" });
	    expect(source.slice(parsed.markers[1]!.start, parsed.markers[1]!.end)).toBe("%% col:60 %%");
	    expect(columnTracks(parsed.items)).toBe("minmax(0, 40fr) minmax(0, 60fr)");
	  });
	  it.each(["Text\n", "", " \n\t\n"])("accepts closed compact single columns containing %j", (content) => {
	    const source = `%% cols %%\n${content}%% endcols %%`;
	    const parsed = parseMarkerLayout(source);
	    expect(scanMarkerLayouts(source)).toHaveLength(1);
	    expect(parsed.items).toEqual([{ width: { kind: "auto" }, markdown: content }]);
	    expect(parsed.markers[0]!.implicit).toBe(true);
	    expect(scanMarkerLayouts(wrap("Text"))).toEqual([]);
	  });
	  it("keeps a nested layout immediately after the opener in the implicit first column", () => {
	    const child = wrap("%% col-break %%\nChild");
	    const source = `%% cols %%\n${child}\n%% col %%\nOther\n%% endcols %%`;
	    const regions = scanMarkerLayouts(source);
	    expect(regions.map((region) => region.depth)).toEqual([0, 1]);
	    expect(source.slice(regions[1]!.start, regions[1]!.end)).toBe(`${child}\n`);
	    expect(parseMarkerLayout(source).items[0]!.markdown).toBe(`${child}\n`);
	  });
	  it.each([
	    ["colsdown", ["", ""], true],
	    ["stack", ["", ""], true],
	    ["colsdown", ["1fr", "2fr"], true],
	    ["colsdown", ["1fr", ""], false],
	    ["colsdown", ["1fr", "", ""], false],
	    ["colsdown", ["1fr"], false],
	    ["colsdown", ["100%"], false],
	    ["colsdown", ["40%", "60%"], true],
	    ["stack", ["40%", "60%"], true],
	    ["colsdown", ["2fr", "1fr"], false],
	    ["colsdown", ["20%", "30%"], false],
	  ] as const)("omits only inferable first boundaries for %s %j", (language, widths, implicit) => {
	    const source = layoutTemplate(language, [...widths], ":::", "markers");
	    const parsed = parseMarkerLayout(source);
	    expect(parsed.items).toHaveLength(widths.length);
	    expect(Boolean(parsed.markers[0]!.implicit)).toBe(implicit);
	    expect(columnTracks(parsed.items)).toBe(columnTracks(widths.map((width, index) => ({ width: normalizeWidth(width), markdown: `${index}` }))));
	    expect(source.split("\n")[1]).toBe(implicit ? `${language === "stack" ? "Section" : "Column"} 1` : `%% col:${widths[0].replace(/%$/, "")} %%`);
	  });
	  it.each([true, false])("keeps mixed-family nested layouts scoped (compact parent: %s)", (compactParent) => {
	    const legacy = wrap("%% col-break:25 %%\nChild");
	    const compact = "%% cols:stack %%\n%% col:25 %%\nChild\n%% endcols %%";
	    const child = compactParent ? legacy : compact;
	    const source = compactParent
	      ? `%% cols %%\n%% col:40 %%\n${child}\n%% col:60 %%\nOther\n%% endcols %%`
	      : wrap(`%% col-break:40 %%\n${child}\n%% col-break:60 %%\nOther`);
	    const regions = scanMarkerLayouts(source);
	    expect(regions.map((region) => region.depth)).toEqual([0, 1]);
	    expect(regions[1]!.body).toBe(`${child}\n`);
	    expect(source.slice(regions[1]!.start, regions[1]!.end)).toBe(regions[1]!.body);
	    expect(parseMarkerLayout(source).items.map((item) => item.width.value)).toEqual([40, 60]);
	    expect(parseMarkerLayout(source).items[0]!.markdown).toBe(`${child}\n`);
	  });
	  it("discovers nested marker layouts and preserves them in the parent column", () => {
	    const child = wrap("%% col-break %%\nChild", ":l:stack");
	    const source = wrap(`%% col-break %%\n${child}\n%% col-break:auto %%\nSibling`);
	    const regions = scanMarkerLayouts(source);
	    expect(regions.map((r) => [r.depth, r.direction])).toEqual([[0, "row"], [1, "column"]]);
	    expect(parseMarkerLayout(source).items).toHaveLength(2);
	    expect(parseMarkerLayout(source).items[0]!.markdown).toBe(`${child}\n`);
	    expect(parseMarkerLayout(child).direction).toBe("column");
	  });
	  it("treats ordinary fences as opaque and scans inside layout fences", () => {
	    const marker = wrap("%% col-break %%\nExample");
	    const source = `\`\`\`md\n${marker}\n\`\`\`\n\`\`\`colsdown\n${marker}\n\`\`\``;
	    expect(scanMarkerLayouts(source)).toHaveLength(1);
	    expect(scanMarkerLayouts(source)[0]!.depth).toBe(1);
	    const parent = wrap(`%% col-break %%\n\`\`\`md\n%% col-break:30 %%\n\`\`\`\nText`);
	    expect(parseMarkerLayout(parent).items).toHaveLength(1);
	    expect(parseMarkerLayout(parent).items[0]!.markdown).toContain("%% col-break:30 %%");
	  });
	  it("rejects unfinished and empty regions and nonstandalone markers", () => {
	    for (const source of ["%% col-start %%\n%% col-break %%\nAfter", wrap("Prelude"), "Text %% col-start %%\n%% col-break %%\n%% col-end %%"]) {
	      expect(scanMarkerLayouts(source)).toEqual([]);
	      expect(parseMarkerLayout(source).items[0]!.markdown).toBe(source);
	    }
	  });
	  it("retains CRLF offsets and exact line bounds", () => {
	    const marker = wrap("%% col-break:w:40:unknown %%\nText").replace(/\n/g, "\r\n");
	    const note = `Before\r\n${marker}\r\n\r\nAfter`;
	    const region = scanMarkerLayouts(note)[0]!;
	    expect(region.body).toBe(`${marker}\r\n`);
	    expect(note.slice(region.start, region.end)).toBe(region.body);
	    expect([region.lineStart, region.lineEnd]).toEqual([1, 4]);
	    expect(parseMarkerLayout(region.body).items[0]!.width).toEqual({ kind: "percent", value: 40 });
	  });
	  it("keeps marker examples in frontmatter and multiline comments inert", () => {
	    const example = wrap("%% col-break %%\nExample");
	    const note = `---\nexample: |\n${example}\n---\n<!--\n${example}\n-->\n%%\n${example}\n%%\n${example}`;
	    const found = scanMarkerLayouts(note);
	    expect(found).toHaveLength(1);
	    expect(found[0]!.start).toBe(note.lastIndexOf(example));
	    const parent = wrap(`%% col-break %%\n<!--\n%% col-break:30 %%\n-->\n%%\n%% col-break:20 %%\n%%\nContent`);
	    expect(parseMarkerLayout(parent).items).toHaveLength(1);
	    expect(parseMarkerLayout(parent).items[0]!.markdown).toContain("col-break:30");
	  });
	  it("accepts comma metadata boundaries without adding styling behavior", () => {
	    const source = wrap("%% col-break:40,b:blue-soft %%\nText", ":l:stack,gap:20");
	    expect(parseMarkerLayout(source).direction).toBe("column");
	    expect(parseMarkerLayout(source).items[0]!.width).toEqual({ kind: "percent", value: 40 });
	  });
	  it("uses explicit dispatch and keeps fenced parser semantics", () => {
	    const source = layoutTemplate("colsdown", ["40%", "2fr", ""], "CUSTOM", "markers");
	    expect(source).toContain("%% col:40 %%");
	    expect(source).toContain("%% col:2fr %%");
	    expect(source).not.toContain(":w:");
	    expect(source.startsWith("%% cols %%\n")).toBe(true);
	    expect(source.endsWith("\n%% endcols %%")).toBe(true);
	    expect(parseLayout(source).items).toHaveLength(1);
	    expect(parseLayoutSource(source, "row", "CUSTOM", "markers").items).toHaveLength(3);
	    expect(layoutTemplate("stack", ["", ""], "::: ", "markers")).toContain("cols:stack");
	  });
	});
});

describe("Layout scanner contexts", () => {
  const { scanEditorLayouts } = require("../src/markers.cjs") as {
    scanEditorLayouts: (source: string, options?: { fragment?: boolean }) => Array<{ syntax: string; start: number; end: number }>;
  };
  const marker = "%% cols %%\nLeft\n%% col %%\nRight\n%% endcols %%";
  const fence = "```colsdown\nLeft\n:::\nRight\n```";
  it.each([
    "Text `<!--` stays literal.", "Text `%%` stays literal.", "Text ``one ` <!--`` stays literal.",
    "Text `literal\n<!--\n` stays literal.", "Text ``literal\n%%\n`` stays literal.",
    "Text `literal\r\n<!--\r\n` stays literal.", "Text ``literal\r\n%%\r\n`` stays literal.",
  ])("does not interpret comment delimiters inside matched code spans: %j", (prefix) => {
    const source = `${prefix}\n\n${marker}\n\n${fence}`;
    const layouts = scanEditorLayouts(source);
    expect(layouts.map((layout) => layout.syntax)).toEqual(["markers", "fenced"]);
    expect(layouts.map((layout) => layout.start)).toEqual([source.indexOf(marker), source.indexOf(fence)]);
  });
  it.each([
    "`x`%% cols %%\nLeft\n%% col %%\nRight\n%% endcols %%",
    "`x`~~~colsdown\nLeft\n:::\nRight\n~~~",
  ])("does not promote code-masked prose prefixes into standalone layout openers: %j", (source) => {
    expect(scanEditorLayouts(source)).toEqual([]);
  });
  it("keeps multiline code-span marker examples inert while rendering later layouts", () => {
    const example = `Text \`${marker}\n\` is code.`;
    const source = `${example}\n\n${marker}\n\n${fence}`;
    expect(scanEditorLayouts(source).map((layout) => layout.start)).toEqual([source.lastIndexOf(marker), source.indexOf(fence)]);
  });
  it("does not let an unmatched backtick hide later layouts or shield a real comment", () => {
    expect(scanEditorLayouts(`Text \` unmatched\n\n${marker}\n${fence}`)).toHaveLength(2);
    const source = `Text \` unmatched <!--\n${marker}\n${fence}\n-->\n${marker}`;
    expect(scanEditorLayouts(source).map((layout) => layout.start)).toEqual([source.lastIndexOf(marker)]);
  });
  it.each(["\n", "\r\n"])("respects odd and even backslash escapes before comment openers (%j)", (newline) => {
    for (const [opener, closer] of [["<!--", "-->"], ["%%", "%%"]]) {
      for (const count of [1, 3]) {
        const source = `Literal ${"\\".repeat(count)}${opener}\n${marker}\n${fence}`.replace(/\n/g, newline);
        expect(scanEditorLayouts(source).map((layout) => layout.syntax)).toEqual(["markers", "fenced"]);
      }
      for (const count of [0, 2]) {
        const source = `Literal ${"\\".repeat(count)}${opener}\n${fence}\n${closer}\n${marker}\n${fence}`.replace(/\n/g, newline);
        expect(scanEditorLayouts(source).map((layout) => layout.start)).toEqual([source.lastIndexOf(marker.replace(/\n/g, newline)), source.lastIndexOf(fence.replace(/\n/g, newline))]);
      }
    }
  });
  it.each(["\n", "\r\n"])("does not close a percent comment at an escaped delimiter (%j)", (newline) => {
    const source = `Text %% open\n\\%%\n${fence}\n%%\n${marker}`.replace(/\n/g, newline);
    expect(scanEditorLayouts(source).map((layout) => layout.start)).toEqual([source.lastIndexOf(marker.replace(/\n/g, newline))]);
  });
  it.each(["<!-- hidden \\-->", "<!--\nHidden \\-->"])("closes HTML comments at a literal closer even after a backslash: %j", (comment) => {
    const source = `${comment}\n${marker}\n${fence}`;
    expect(scanEditorLayouts(source).map((layout) => layout.syntax)).toEqual(["markers", "fenced"]);
    expect(scanEditorLayouts(source).map((layout) => layout.start)).toEqual([source.indexOf(marker), source.indexOf(fence)]);
  });
  it("leaves real HTML and percent comments opaque", () => {
    const source = `<!--\n${marker}\n${fence}\n-->\n%%\n${marker}\n${fence}\n%%\n${marker}\n${fence}`;
    expect(scanEditorLayouts(source).map((layout) => layout.start)).toEqual([source.lastIndexOf(marker), source.lastIndexOf(fence)]);
  });
  it("distinguishes fragment thematic breaks from complete full-note frontmatter", () => {
    const fragment = `---\n\n${marker}\n\n---\n\n${fence}`;
    expect(scanEditorLayouts(fragment, { fragment: true }).map((layout) => layout.syntax)).toEqual(["markers", "fenced"]);
    expect(scanEditorLayouts(fragment).map((layout) => layout.syntax)).toEqual(["fenced"]);
    const note = `---\nexample: |\n${marker}\n${fence}\n---\n${marker}\n${fence}`;
    expect(scanEditorLayouts(note).map((layout) => layout.start)).toEqual([note.lastIndexOf(marker), note.lastIndexOf(fence)]);
    expect(scanEditorLayouts(`---\n\n${marker}\n${fence}`)).toHaveLength(2);
  });
});

describe("Marker and fenced Live Preview", () => {
  type ItemRegistration = { element: HTMLElement; from: number; to: number; renderPreview: (markdown?: string, from?: number) => Promise<void> };
  type Context = {
    layoutHandle: { start: number; bodyStart?: number; syntax: string };
    inlineEditing?: { registerItem: (item: ItemRegistration) => () => void };
  };
  type Renderer = (_plugin: unknown, markdown: string, target: HTMLElement, context: Context, direction?: string) => Promise<void>;
  const { EditorSelection, EditorState, StateEffect, StateField } = loadModule("@codemirror/state") as typeof import("@codemirror/state");
  const { Decoration, Direction, EditorView, WidgetType } = loadModule("@codemirror/view") as typeof import("@codemirror/view");
  const layoutApi = require("../src/layout.cjs") as { parseLayoutSource: (source: string, direction: string, separator: string, syntax: string) => { items: Array<{ markdown: string }> } };
  const mapping = require("../src/marker-rendering.cjs") as {
    layoutItemRanges: (source: string, parsed: unknown, syntax: string) => Array<{ from: number; to: number }>;
    scanEditorLayouts: (source: string) => Array<{ syntax: string; start: number; end: number }>;
  };
  const views: InstanceType<typeof EditorView>[] = [];
  const containers: HTMLElement[] = [];
  afterEach(() => {
    views.splice(0).forEach((view) => view.destroy());
    containers.splice(0).forEach((container) => container.remove());
    window.getSelection()?.removeAllRanges();
  });
  const marker = "%% cols %%\nLeft\n%% col %%\nRight\n%% endcols %%";
  const fence = "```colsdown\nLeft\n:::\nRight\n```";
  const settle = async () => { for (let turn = 0; turn < 8; turn += 1) await Promise.resolve(); };

  function runtime(source: string, options: { live?: boolean; anchor?: number; renderer?: Renderer; rejectHostEdits?: boolean; readOnly?: boolean; competingNativeFence?: boolean; preview?: (markdown: string) => Promise<void>; hostLineSeparator?: string } = {}) {
    vi.spyOn(EditorView.prototype, "requestMeasure").mockImplementation(() => {});
    const liveField = StateField.define({ create: () => options.live !== false, update: (value) => value });
    let view: InstanceType<typeof EditorView>;
    const undoStack: import("@codemirror/state").ChangeSet[] = []; const redoStack: typeof undoStack = [];
    let restoring = false;
    const replay = (from: typeof undoStack, to: typeof undoStack) => {
      const changes = from.pop(); if (!changes) return;
      to.push(changes.invert(view.state.doc)); restoring = true;
      try { view.dispatch({ changes }); } finally { restoring = false; }
    };
    const undo = vi.fn(() => replay(undoStack, redoStack));
    const redo = vi.fn(() => replay(redoStack, undoStack));
    const infoField = StateField.define({ create: () => ({ file: { path: "note.md" }, editor: { undo, redo } }), update: (value) => value });
    class TestScope {
      handlers: Array<{ modifiers: string[]; key: string; callback: (event: KeyboardEvent) => boolean | void }> = [];
      constructor(public parent: unknown) { keyScopes.push(this); }
      register(modifiers: string[], key: string, callback: (event: KeyboardEvent) => boolean | void) { this.handlers.push({ modifiers, key, callback }); }
    }
    const keyScopes: TestScope[] = []; const parentScope = {};
    const pushScope = vi.fn(); const popScope = vi.fn();
    const path = loadModule.resolve("../src/marker-editor.cjs");
    const previous = loadModule.cache[path]; const original = moduleInternals._load;
    let api: { registerMarkerEditor: (plugin: unknown, renderer: Renderer) => void };
    delete loadModule.cache[path];
    moduleInternals._load = (id, parent, isMain) => id === "obsidian"
      ? { ...ObsidianMock, Scope: TestScope, editorLivePreviewField: liveField, editorInfoField: infoField }
      : original.call(Module, id, parent, isMain);
    try { api = loadModule(path) as typeof api; }
    finally { moduleInternals._load = original; if (previous) loadModule.cache[path] = previous; else delete loadModule.cache[path]; }
    const owners = new Set<ObsidianMock.MarkdownRenderChild>();
    let extension: import("@codemirror/state").Extension = [];
    const plugin = {
      app: { scope: parentScope, keymap: { pushScope, popScope }, vault: { getAbstractFileByPath: () => ({ path: "note.md" }), cachedRead: async () => source }, workspace: { getLeavesOfType: () => [] } },
      settings: { separator: ":::" },
      registerEditorExtension: (value: typeof extension) => { extension = value; },
      addChild: (owner: ObsidianMock.MarkdownRenderChild) => { owners.add(owner); return owner; },
      removeChild: (owner: ObsidianMock.MarkdownRenderChild) => { owners.delete(owner); owner.unload(); return owner; },
    };
    const defaultRenderer: Renderer = async (_plugin, markdown, target, context) => {
      const syntax = context.layoutHandle.syntax;
      const parsed = layoutApi.parseLayoutSource(markdown, "row", ":::", syntax);
      const ranges = mapping.layoutItemRanges(markdown, parsed, syntax);
      const base = syntax === "fenced" ? context.layoutHandle.bodyStart! : context.layoutHandle.start;
      for (const [index, range] of ranges.entries()) {
        const item = document.createElement("div"); item.className = "layout-item";
        item.dataset.colsdownSourceOffset = String(base + range.from); target.append(item);
        const renderPreview = async (currentMarkdown?: string) => {
          if (options.preview && currentMarkdown !== undefined) await options.preview(currentMarkdown);
          item.replaceChildren();
          const paragraph = document.createElement("p");
          paragraph.textContent = currentMarkdown ?? parsed.items[index]!.markdown.replace(/\r?\n$/, "");
          item.append(paragraph);
          for (const tag of ["a", "button", "input", "textarea", "select", "summary"] as const) {
            const control = document.createElement(tag); control.textContent = tag;
            if (tag === "a") control.setAttribute("href", "#");
            if (tag === "input") control.setAttribute("type", "checkbox");
            item.append(control);
          }
          for (const className of ["colsdown-add-column", "colsdown-resize-handle", "internal-embed", "cm-editor"]) {
            const control = document.createElement("span"); control.className = className; control.textContent = className; item.append(control);
          }
          const editable = document.createElement("span"); editable.setAttribute("contenteditable", "true"); item.append(editable);
        };
        await renderPreview();
        context.inlineEditing?.registerItem({ element: item, from: base + range.from, to: base + range.to, renderPreview });
      }
    };
    const render = vi.fn(options.renderer ?? defaultRenderer);
    api.registerMarkerEditor(plugin, render);
    const parent = document.createElement("div"); document.body.append(parent); containers.push(parent);
    class NativeFenceWidget extends WidgetType {
      toDOM() { const element = document.createElement("div"); element.className = "native-fence-preview"; element.textContent = "Native fence preview"; return element; }
    }
    const nativeDecorations = (state: import("@codemirror/state").EditorState) => Decoration.set(mapping.scanEditorLayouts(state.doc.toString())
      .filter((candidate) => candidate.syntax === "fenced")
      .map((candidate) => Decoration.replace({ block: true, widget: new NativeFenceWidget() }).range(candidate.start, candidate.end)));
    const nativeField = StateField.define({ create: () => Decoration.none, update: (value, transaction) => transaction.docChanged ? nativeDecorations(transaction.state) : value, provide: (field) => EditorView.decorations.from(field) });
    view = new EditorView({ parent, state: EditorState.create({ doc: source, selection: { anchor: options.anchor ?? 0 }, extensions: [liveField, infoField, options.hostLineSeparator === undefined ? [] : EditorState.lineSeparator.of(options.hostLineSeparator), options.competingNativeFence ? nativeField : [], extension, EditorState.readOnly.of(options.readOnly ?? false), EditorState.transactionFilter.of((transaction) => options.rejectHostEdits && transaction.docChanged ? [] : transaction), EditorView.updateListener.of((update) => {
      if (restoring || !update.docChanged) return;
      for (const transaction of update.transactions) if (transaction.docChanged) undoStack.push(transaction.changes.invert(transaction.startState.doc));
      redoStack.length = 0;
    })] }) });
    views.push(view);
    const edit = (editor: InstanceType<typeof EditorView>, from: number, to: number, insert: string) => {
      editor.dispatch({ changes: { from, to, insert } });
    };
    const items = () => Array.from(parent.querySelectorAll<HTMLElement>(".layout-item"));
    const child = () => {
      const element = parent.querySelector<HTMLElement>(".colsdown-inline-editor .cm-editor");
      return element ? EditorView.findFromDOM(element) : null;
    };
    const open = (index: number, event: MouseEventInit = {}) => { items()[index]!.querySelector("p")!.dispatchEvent(new MouseEvent("click", { bubbles: true, ...event })); return child(); };
    return { view, parent, render, owners, items, child, open, edit, undo, redo, keyScopes, parentScope, pushScope, popScope, widget: () => parent.querySelector<HTMLElement>(".colsdown-marker-widget") };
  }

  it("does not register without Obsidian's public Live Preview fields", () => {
    const { registerMarkerEditor } = require("../src/marker-editor.cjs") as { registerMarkerEditor: (plugin: unknown, renderer: unknown) => void };
    const registerEditorExtension = vi.fn(); registerMarkerEditor({ registerEditorExtension }, vi.fn());
    expect(registerEditorExtension).not.toHaveBeenCalled();
  });

  it.each([marker, fence])("keeps layouts rendered for selections inside, at boundaries, and at EOF: %s", async (layout) => {
    const source = `Before\n${layout}\nAfter`;
    const h = runtime(source); await settle();
    const widget = h.widget(); expect(widget).not.toBeNull();
    for (const anchor of [source.indexOf("Left"), source.indexOf("Right"), source.indexOf("After"), source.length]) {
      h.view.dispatch({ selection: { anchor } });
      expect(h.widget()).toBe(widget);
    }
    expect(runtime(source, { live: false }).widget()).toBeNull();
    expect(runtime(layout, { anchor: layout.length }).widget()).not.toBeNull();
    expect(widget?.querySelector(".colsdown-marker-edit")).toBeNull();
  });

  it.each([
    { newline: "\n", syntax: "markers" }, { newline: "\r\n", syntax: "markers" },
    { newline: "\n", syntax: "fenced" }, { newline: "\r\n", syntax: "fenced" },
  ])("opens the exact nested $syntax body after whitespace before the first explicit fenced separator ($newline)", async ({ newline, syntax }) => {
    const production = require("../src/main.cjs") as { renderLayout: Renderer };
    vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, text, element) => {
      const paragraph = document.createElement("p"); paragraph.textContent = text; element.append(paragraph);
    });
    const registered: ItemRegistration[] = [];
    const renderer: Renderer = (plugin, markdown, target, context, direction) => {
      const editing = context.inlineEditing!; const register = editing.registerItem.bind(editing);
      editing.registerItem = (item) => { registered.push(item); return register(item); };
      return production.renderLayout(plugin, markdown, target, context, direction);
    };
    const nested = syntax === "markers" ? "%% cols %%\nDeep one\n%% col %%\nDeep two\n%% endcols %%" : "```colsdown\nDeep one\n:::\nDeep two\n```";
    const source = `Before\n\`\`\`\`colsdown\n\n:::\n${nested}\n:::\nOuter sibling\n\`\`\`\`\nAfter`.replace(/\n/g, newline);
    const h = runtime(source, { renderer });
    await vi.waitFor(() => expect(registered).toHaveLength(4));
    const current = h.view.state.doc.toString(); const from = current.indexOf("Deep one");
    const deep = registered.find((item) => item.from === from && item.to === from + "Deep one".length);
    expect(deep).toBeDefined();
    deep!.element.querySelector("p")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const child = h.child()!; expect(child.state.doc.toString()).toBe("Deep one");
    h.edit(child, 0, child.state.doc.length, "Deep edited");
    expect(h.view.state.doc.toString()).toBe(current.replace("Deep one", "Deep edited"));
    expect(h.parent.textContent).toContain("Deep two"); expect(h.parent.textContent).toContain("Outer sibling");
  });

  it("registers current editable ranges when host text changes during delayed initial Markdown rendering", async () => {
    const production = require("../src/main.cjs") as { renderLayout: Renderer };
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const markdown = vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, text, element) => {
      if (first) { first = false; await pending; }
      const paragraph = document.createElement("p"); paragraph.textContent = text; element.append(paragraph);
    });
    const h = runtime(marker, { renderer: production.renderLayout });
    expect(markdown).toHaveBeenCalledOnce();
    h.view.dispatch({ changes: { from: marker.indexOf("Left"), to: marker.indexOf("Left") + 4, insert: "X" } });
    release();
    await vi.waitFor(() => {
      expect(h.parent.querySelectorAll("[data-colsdown-inline-item]")).toHaveLength(2);
    });
    const initialPreview = h.items()[0]!.querySelector("p")?.textContent;
    const firstEditor = h.open(0)!; expect(firstEditor.state.doc.toString()).toBe("X");
    expect(initialPreview?.replace(/\r?\n$/, "")).toBe("X");
    h.edit(firstEditor, 0, firstEditor.state.doc.length, "First edited");
    const secondEditor = h.open(1)!; expect(secondEditor.state.doc.toString()).toBe("Right");
    h.edit(secondEditor, 0, secondEditor.state.doc.length, "Second edited");
    expect(h.view.state.doc.toString()).toBe(marker.replace("Left", "First edited").replace("Right", "Second edited"));
  });

  it("never opens stale nested ranges while initial and corrective Markdown renders are pending", async () => {
    const production = require("../src/main.cjs") as { renderLayout: Renderer };
    let releaseInitial: () => void = () => {}; let releaseCurrent: () => void = () => {};
    const initial = new Promise<void>((resolve) => { releaseInitial = resolve; });
    const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
    let initialStarted = false; let currentStarted = false;
    vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, text, element) => {
      if (text.trim() === "Lead" && !initialStarted) { initialStarted = true; await initial; }
      if (text.trim() === "X" && !currentStarted) { currentStarted = true; await current; }
      const paragraph = document.createElement("p"); paragraph.textContent = text; element.append(paragraph);
    });
    const source = "%% cols %%\nLead\n\n%% cols %%\nNested A\n%% col %%\nNested B\n%% endcols %%\n%% col %%\nOuter sibling\n%% endcols %%";
    const h = runtime(source, { renderer: production.renderLayout });
    try {
      await vi.waitFor(() => expect(initialStarted).toBe(true));
      const from = source.indexOf("Lead"); h.view.dispatch({ changes: { from, to: from + 4, insert: "X" } });
      releaseInitial(); await vi.waitFor(() => expect(currentStarted).toBe(true)); await settle();
      for (const paragraph of Array.from(h.parent.querySelectorAll(".layout-item p"))) {
        if (paragraph.textContent?.trim().startsWith("Nested")) {
          paragraph.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          expect(h.child()).toBeNull();
        }
      }
      expect(h.child()).toBeNull(); expect(h.view.state.doc.toString()).toBe(source.replace("Lead", "X"));
      releaseCurrent();
      await vi.waitFor(() => expect(h.parent.querySelectorAll("[data-colsdown-inline-item]")).toHaveLength(4)); await settle();
      const clickNested = (label: string) => {
        const paragraph = Array.from(h.parent.querySelectorAll(".layout-item p")).find((element) => element.textContent?.trim() === label)!;
        expect(paragraph).toBeDefined(); paragraph.dispatchEvent(new MouseEvent("click", { bubbles: true })); return h.child()!;
      };
      const first = clickNested("Nested A"); expect(first.state.doc.toString()).toBe("Nested A"); h.edit(first, 0, first.state.doc.length, "Edited A");
      const second = clickNested("Nested B"); expect(second.state.doc.toString()).toBe("Nested B"); h.edit(second, 0, second.state.doc.length, "Edited B");
      expect(h.view.state.doc.toString()).toBe(source.replace("Lead", "X").replace("Nested A", "Edited A").replace("Nested B", "Edited B"));
      expect(h.parent.textContent).toContain("Outer sibling");
    } finally { releaseInitial(); releaseCurrent(); }
  });

  it("closes the previous editor across root and nested layouts even when native blur observers miss focus changes", async () => {
    const addedListeners = vi.spyOn(document, "addEventListener");
    const removedListeners = vi.spyOn(document, "removeEventListener");
    const production = require("../src/main.cjs") as { renderLayout: Renderer };
    vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, text, element) => {
      const paragraph = document.createElement("p"); paragraph.textContent = text; element.append(paragraph);
    });
    const source = `${fence}\n\n%% cols %%\nOuter\n\`\`\`colsdown\nNested left\n:::\nNested right\n\`\`\`\n%% col %%\nOuter sibling\n%% endcols %%`;
    const h = runtime(source, { renderer: production.renderLayout });
    await vi.waitFor(() => expect(h.parent.querySelectorAll("[data-colsdown-inline-item]")).toHaveLength(6));
    const first = h.open(0)!; const destroy = vi.spyOn(first, "destroy");
    h.edit(first, 0, first.state.doc.length, "First saved");
    first.contentDOM.addEventListener("blur", (event) => event.stopImmediatePropagation(), { capture: true });
    const nested = Array.from(h.parent.querySelectorAll(".layout-item p")).find((element) => element.textContent?.trim() === "Nested left")!;
    nested.dispatchEvent(new MouseEvent("click", { bubbles: true })); await settle();
    expect(h.parent.querySelectorAll(".colsdown-inline-editor")).toHaveLength(1); expect(destroy).toHaveBeenCalledOnce();
    const second = h.child()!; expect(second).not.toBe(first); expect(second.state.doc.toString()).toBe("Nested left");
    h.edit(second, 0, second.state.doc.length, "Nested saved");
    second.contentDOM.addEventListener("blur", (event) => event.stopImmediatePropagation(), { capture: true });
    const outside = document.createElement("button"); h.parent.append(outside); outside.focus(); await settle();
    expect(h.parent.querySelectorAll(".colsdown-inline-editor")).toHaveLength(0);
    expect(h.view.state.doc.toString()).toBe(source.replace("Left", "First saved").replace("Nested left", "Nested saved"));
    expect(h.parent.textContent).toContain("Right"); expect(h.parent.textContent).toContain("Nested right"); expect(h.parent.textContent).toContain("Outer sibling");
    const watches = addedListeners.mock.calls.filter(([type, _listener, capture]) => type === "focusin" && capture === true);
    expect(watches).toHaveLength(2);
    for (const [type, listener, capture] of watches) expect(removedListeners).toHaveBeenCalledWith(type, listener, capture);
  });

  it("retains its fenced widgets over competing native decorations after editing a marker sibling", async () => {
    const source = `${marker}\n\n${fence}`;
    const h = runtime(source, { competingNativeFence: true }); await settle();
    const fencedWidget = h.parent.querySelectorAll(".colsdown-marker-widget")[1];
    expect(fencedWidget).toBeDefined(); expect(h.parent.querySelector(".native-fence-preview")).toBeNull();
    const child = h.open(0)!; h.edit(child, 0, 4, "Marker changed"); await settle();
    expect(h.parent.querySelectorAll(".colsdown-marker-widget")).toHaveLength(2);
    expect(h.parent.querySelectorAll(".colsdown-marker-widget")[1]).toBe(fencedWidget);
    expect(h.parent.querySelector(".native-fence-preview")).toBeNull(); expect(h.child()).toBe(child);
  });

  it.each([marker, fence])("edits only the clicked column, saves immediately, and keeps sibling DOM: %s", async (layout) => {
    const source = `Before\n${layout}\nAfter`;
    const h = runtime(source); await settle();
    const widget = h.widget(); const sibling = h.items()[0]!; const paragraph = sibling.querySelector("p");
    const child = h.open(1); expect(child).not.toBeNull();
    expect(child!.state.doc.toString()).toBe("Right");
    h.edit(child!, 0, child!.state.doc.length, "**Right changed**\n\nPasted line");
    expect(h.view.state.doc.toString()).toBe(source.replace("Right", "**Right changed**\n\nPasted line"));
    expect(h.widget()).toBe(widget); expect(h.items()[0]).toBe(sibling); expect(sibling.querySelector("p")).toBe(paragraph);
    expect(h.child()).toBe(child); expect(sibling.textContent).toContain("Left");
  });

  it.each([marker, fence])("select-all deletion preserves the column separators and closing syntax: %s", async (layout) => {
    const source = `Before\n${layout}\nAfter`;
    const h = runtime(source); await settle(); const child = h.open(1)!;
    h.edit(child, 0, child.state.doc.length, "");
    expect(h.view.state.doc.toString()).toBe(source.replace("Right", ""));
    expect(h.widget()).not.toBeNull(); expect(h.items()).toHaveLength(2); expect(h.child()).toBe(child);
    h.edit(child, 0, 0, "Restored"); expect(h.view.state.doc.toString()).toBe(source.replace("Right", "Restored"));
  });

  it.each(["%% cols %%\n%% col %%\n\n%% col %%\nRight\n%% endcols %%", "```colsdown\n:::\n\n:::\nRight\n```"])("edits an empty first column without consuming structural newlines: %s", async (layout) => {
    const h = runtime(layout); await settle();
    const child = h.open(0)!; expect(child.state.doc.length).toBe(0);
    h.edit(child, 0, 0, "New first"); expect(h.view.state.doc.toString()).toContain("New first\n"); expect(h.items()).toHaveLength(2);
  });

  it.each([
    { syntax: "markers", newline: "\n" }, { syntax: "markers", newline: "\r\n" },
    { syntax: "fenced", newline: "\n" }, { syntax: "fenced", newline: "\r\n" },
  ])("omits boundary blank lines from the $syntax editor while preserving source through typing, undo, and reopen ($newline)", async ({ syntax, newline }) => {
    const body = "\n \t\n  Left  \n\n\t \n";
    const source = (syntax === "markers" ? `%% cols %%\n${body}%% col %%\nRight\n%% endcols %%` : `\`\`\`colsdown\n${body}:::\nRight\n\`\`\``).replace(/\n/g, newline);
    const h = runtime(source); await settle(); const original = h.view.state.doc.toString(); const sibling = h.items()[1]!;
    const child = h.open(0)!; expect(child.state.doc.toString()).toBe("  Left  ");
    h.edit(child, 0, child.state.doc.length, "  Edited  ");
    expect(h.view.state.doc.toString()).toBe(original.replace("  Left  ", "  Edited  "));
    child.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", keyCode: 90, ctrlKey: true, bubbles: true, cancelable: true })); await settle();
    expect(h.view.state.doc.toString()).toBe(original); expect(h.child()?.state.doc.toString()).toBe("  Left  ");
    h.child()!.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Z", code: "KeyZ", keyCode: 90, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); await settle();
    expect(h.view.state.doc.toString()).toBe(original.replace("  Left  ", "  Edited  ")); expect(h.child()?.state.doc.toString()).toBe("  Edited  ");
    h.child()!.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await settle();
    expect(h.child()).toBeNull(); expect(h.open(0)?.state.doc.toString()).toBe("  Edited  "); expect(h.items()[1]).toBe(sibling);
  });

  it("rebases the trimmed active body after external boundary whitespace and content edits", async () => {
    const source = "%% cols %%\n\n \t\n  Left  \n\n\t \n%% col %%\nRight\n%% endcols %%";
    const h = runtime(source); await settle(); const child = h.open(0)!;
    const insertion = source.indexOf("\n") + 1;
    h.view.dispatch({ changes: { from: insertion, insert: "\n" } });
    const withBlank = source.slice(0, insertion) + "\n" + source.slice(insertion);
    const from = withBlank.indexOf("Left"); h.view.dispatch({ changes: { from, to: from + 4, insert: "External" } }); await settle();
    expect(h.child()).toBe(child); expect(child.state.doc.toString()).toBe("  External  ");
    h.edit(child, 0, child.state.doc.length, "  Typed  ");
    expect(h.view.state.doc.toString()).toBe(withBlank.replace("  Left  ", "  Typed  "));
  });

  it.each(["", "3rem"])("reserves the item height before hiding its preview and restores prior min-height %j after async preview", async (previous) => {
    let release: () => void = () => {}; const pending = new Promise<void>((resolve) => { release = resolve; });
    const preview = vi.fn(async () => { await pending; });
    const h = runtime(marker, { preview }); await settle(); const item = h.items()[0]!; const paragraph = item.querySelector<HTMLElement>("p")!;
    item.style.setProperty("min-height", previous, previous ? "important" : "");
    const measuredHidden: boolean[] = [];
    vi.spyOn(item, "getBoundingClientRect").mockImplementation(() => {
      measuredHidden.push(paragraph.hidden);
      return { x: 0, y: 0, width: 300, height: 120, top: 0, right: 300, bottom: 120, left: 0, toJSON() {} };
    });
    try {
      const child = h.open(0)!;
      expect(measuredHidden[0]).toBe(false); expect(paragraph.hidden).toBe(true);
      const reserved = item.style.getPropertyValue("min-height"); expect(Number.parseFloat(reserved)).toBeGreaterThan(0); expect(reserved).not.toBe(previous);
      child.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await settle();
      expect(h.child()).toBeNull(); expect(preview).toHaveBeenCalledOnce(); expect(item.style.getPropertyValue("min-height")).toBe(reserved);
      release(); await vi.waitFor(() => expect(item.style.getPropertyValue("min-height")).toBe(previous));
      expect(item.style.getPropertyPriority("min-height")).toBe(previous ? "important" : "");
    } finally { release(); }
  });

  it("restores reserved height when the replacement preview rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = runtime(marker, { preview: async () => { throw new Error("Preview failed"); } }); await settle();
    const item = h.items()[0]!; item.style.minHeight = "2em";
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 300, height: 120, top: 0, right: 300, bottom: 120, left: 0, toJSON() {} });
    const child = h.open(0)!; expect(item.style.minHeight).not.toBe("2em");
    child.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(item.style.minHeight).toBe("2em")); expect(h.child()).toBeNull();
  });

  it.each(["\n", "\r\n"])("keeps paragraph spacing as presentation decorations through typing and parent undo (%j)", async (newline) => {
    const source = `%% cols %%\n\nFirst paragraph\n\nSecond paragraph\n\n%% col %%\nRight\n%% endcols %%`.replace(/\n/g, newline);
    const h = runtime(source, { hostLineSeparator: newline === "\r\n" ? "\n" : undefined }); await settle();
    const original = h.view.state.doc.toString(); const item = h.items()[0]!;
    const first = document.createElement("p"); first.textContent = "First paragraph";
    const second = document.createElement("p"); second.textContent = "Second paragraph"; item.replaceChildren(first, second);
    const rect = (top: number) => ({ x: 0, y: top, width: 200, height: 20, top, right: 200, bottom: top + 20, left: 0, toJSON() {} });
    const previousRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: function(this: Range) { return [rect(this.toString() === "First paragraph" ? 100 : 184)]; } });
    const coordinates = vi.spyOn(EditorView.prototype, "coordsAtPos").mockImplementation(function(this: InstanceType<typeof EditorView>, position) {
      return rect(68 + (this.state.doc.lineAt(position).number - 1) * 32);
    });
    try {
      const child = h.open(0)!; expect(child.state.doc.toString()).toBe("First paragraph\n\nSecond paragraph");
      expect(h.view.state.doc.toString()).toBe(original);
      const padding = (text: string) => Array.from(child.contentDOM.querySelectorAll<HTMLElement>(".cm-line")).find((line) => line.textContent === text)?.style.paddingTop;
      expect(coordinates).toHaveBeenCalledWith(0); expect(coordinates).toHaveBeenCalledWith("First paragraph\n\n".length);
      expect(padding("First paragraph")).toBe("32px"); expect(padding("Second paragraph")).toBe("20px");
      h.edit(child, "First ".length, "First ".length, `new${child.state.lineBreak}`);
      expect(padding("Second paragraph")).toBe("20px");
      expect(h.view.state.doc.toString()).toBe(original.replace("First paragraph", `First new${newline}paragraph`));
      child.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", keyCode: 90, ctrlKey: true, bubbles: true, cancelable: true })); await settle();
      expect(h.view.state.doc.toString()).toBe(original); expect(h.child()).toBe(child);
      expect(padding("First paragraph")).toBe("32px"); expect(padding("Second paragraph")).toBe("20px");
      child.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Z", code: "KeyZ", keyCode: 90, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); await settle();
      expect(padding("Second paragraph")).toBe("20px");
      expect(h.view.state.doc.toString()).toBe(original.replace("First paragraph", `First new${newline}paragraph`));
    } finally {
      if (previousRects) Object.defineProperty(Range.prototype, "getClientRects", previousRects);
      else Reflect.deleteProperty(Range.prototype, "getClientRects");
    }
  });

  it("does not add line padding when rendered text anchors are above editor text", async () => {
    const h = runtime(marker); await settle(); const original = h.view.state.doc.toString();
    const previousRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    const rect = (top: number) => ({ x: 0, y: top, width: 200, height: 20, top, right: 200, bottom: top + 20, left: 0, toJSON() {} });
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [rect(20)] });
    vi.spyOn(EditorView.prototype, "coordsAtPos").mockReturnValue(rect(60));
    try {
      const child = h.open(0)!;
      expect(Array.from(child.contentDOM.querySelectorAll<HTMLElement>(".cm-line"), (line) => line.style.paddingTop)).toEqual([""]);
      expect(h.view.state.doc.toString()).toBe(original);
    } finally {
      if (previousRects) Object.defineProperty(Range.prototype, "getClientRects", previousRects);
      else Reflect.deleteProperty(Range.prototype, "getClientRects");
    }
  });

  it.each([
    { syntax: "markers", key: "ArrowDown" }, { syntax: "markers", key: "ArrowRight" },
    { syntax: "markers", key: "ArrowUp" }, { syntax: "markers", key: "ArrowLeft" },
    { syntax: "fenced", key: "ArrowDown" }, { syntax: "fenced", key: "ArrowRight" },
    { syntax: "fenced", key: "ArrowUp" }, { syntax: "fenced", key: "ArrowLeft" },
  ])("enters rendered $syntax columns from the host with $key without changing source", async ({ syntax, key }) => {
    const layout = syntax === "markers" ? marker : fence; const source = `Before\n${layout}\nAfter`;
    const forward = key === "ArrowDown" || key === "ArrowRight";
    const h = runtime(source); await settle(); const widget = h.widget(); const items = h.items();
    const start = source.indexOf(layout); const end = source.indexOf("After"); const anchor = forward ? start - 1 : end;
    h.view.dispatch({ selection: { anchor } }); h.view.focus();
    if (key === "ArrowDown" || key === "ArrowUp") {
      vi.spyOn(h.view, "moveVertically").mockReturnValue(EditorSelection.cursor(forward ? start : end - 1));
      vi.spyOn(h.view, "coordsAtPos").mockReturnValue(null);
    }
    const event = new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true });
    h.view.contentDOM.dispatchEvent(event);
    const child = h.child(); expect(child).not.toBeNull(); expect(event.defaultPrevented).toBe(true);
    expect(child!.state.doc.toString()).toBe(forward ? "Left" : "Right");
    expect(child!.state.selection.main.head).toBe(forward ? 0 : child!.state.doc.length);
    expect(h.view.state.doc.toString()).toBe(source); expect(h.widget()).toBe(widget); expect(h.items()).toEqual(items);
  });

  it("uses logical backward movement for physical Right and forward movement for Left in an RTL paragraph", async () => {
    const source = `לפני\n${marker}\nאחרי`; const start = source.indexOf(marker); const anchor = start - 1;
    const h = runtime(source); await settle(); const widget = h.widget();
    vi.spyOn(h.view, "textDirectionAt").mockReturnValue(Direction.RTL);
    const movement = vi.spyOn(h.view, "moveByChar").mockImplementation((selection, forward) => EditorSelection.cursor(selection.head + (forward ? 1 : -1)));
    h.view.dispatch({ selection: { anchor } }); h.view.focus();
    const right = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }); h.view.contentDOM.dispatchEvent(right);
    expect(movement).toHaveBeenLastCalledWith(expect.anything(), false); expect(right.defaultPrevented).toBe(false); expect(h.child()).toBeNull();
    h.view.dispatch({ selection: { anchor } }); h.view.focus();
    const left = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }); h.view.contentDOM.dispatchEvent(left);
    expect(movement).toHaveBeenLastCalledWith(expect.anything(), true); expect(left.defaultPrevented).toBe(true);
    expect(h.child()?.state.doc.toString()).toBe("Left"); expect(h.child()?.state.selection.main.head).toBe(0);
    expect(h.view.state.doc.toString()).toBe(source); expect(h.widget()).toBe(widget);
  });

  it.each([{ syntax: "markers", forward: true }, { syntax: "fenced", forward: false }])("chooses the nearest visible column for vertical entry into $syntax", async ({ syntax, forward }) => {
    const layout = syntax === "markers" ? marker : fence; const source = `Before\n${layout}\nAfter`;
    const h = runtime(source); await settle(); const start = source.indexOf(layout); const end = source.indexOf("After");
    const rect = (left: number) => ({ x: left, y: 80, width: 120, height: 60, top: 80, right: left + 120, bottom: 140, left, toJSON() {} });
    h.items().forEach((item, index) => { vi.spyOn(item, "getBoundingClientRect").mockReturnValue(rect(index * 140)); });
    vi.spyOn(h.view, "moveVertically").mockReturnValue(EditorSelection.cursor(forward ? start : end - 1));
    vi.spyOn(EditorView.prototype, "coordsAtPos").mockReturnValue(rect(forward ? 190 : 50));
    vi.spyOn(EditorView.prototype, "posAtCoords").mockImplementation(function(this: InstanceType<typeof EditorView>) { return forward ? 0 : this.state.doc.length; });
    h.view.dispatch({ selection: { anchor: forward ? start - 1 : end } }); h.view.focus();
    h.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: forward ? "ArrowDown" : "ArrowUp", bubbles: true, cancelable: true }));
    expect(h.child()?.state.doc.toString()).toBe(forward ? "Right" : "Left");
    expect(h.child()?.state.selection.main.head).toBe(forward ? 0 : "Left".length); expect(h.view.state.doc.toString()).toBe(source);
  });

  it("leaves modified arrows, selections, Source mode, read-only views, and other controls alone", async () => {
    for (const scenario of ["ctrlKey", "metaKey", "altKey", "shiftKey", "selection", "multiple", "source", "readonly", "control"]) {
      const source = `Before\n${marker}\nAfter`; const start = source.indexOf(marker);
      const h = runtime(source, { live: scenario !== "source", readOnly: scenario === "readonly" }); await settle();
      vi.spyOn(h.view, "moveVertically").mockReturnValue(EditorSelection.cursor(start));
      vi.spyOn(h.view, "coordsAtPos").mockReturnValue(null);
      h.view.dispatch({ selection: { anchor: start - 1 } });
      if (scenario === "selection") h.view.dispatch({ selection: { anchor: 0, head: start - 1 } });
      if (scenario === "multiple") {
        h.view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.allowMultipleSelections.of(true)) });
        h.view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(start - 1)], 1) });
      }
      h.view.focus();
      if (scenario === "control") { const button = document.createElement("button"); h.parent.append(button); button.focus(); }
      const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true, ...(["ctrlKey", "metaKey", "altKey", "shiftKey"].includes(scenario) ? { [scenario]: true } : {}) });
      h.view.contentDOM.dispatchEvent(event);
      expect(h.child(), scenario).toBeNull(); expect(event.defaultPrevented, scenario).toBe(false); expect(h.view.state.doc.toString(), scenario).toBe(source);
    }
  });

  it("selects only the focused column using the local Mod-a keymap and public app scope", async () => {
    const h = runtime(marker); await settle(); const child = h.open(0)!; const parentSelection = h.view.state.selection;
    child.dispatch({ selection: { anchor: 2 } });
    const local = new KeyboardEvent("keydown", { key: "a", code: "KeyA", keyCode: 65, ctrlKey: true, bubbles: true, cancelable: true });
    child.contentDOM.dispatchEvent(local);
    expect(local.defaultPrevented).toBe(true); expect(child.state.selection.main.from).toBe(0); expect(child.state.selection.main.to).toBe(child.state.doc.length);
    expect(document.activeElement).toBe(child.contentDOM); expect(h.view.state.selection.eq(parentSelection)).toBe(true);
    const scope = h.keyScopes[0]!; expect(scope.parent).toBe(h.parentScope); expect(h.pushScope).toHaveBeenCalledWith(scope);
    const handler = scope.handlers[0]!; expect(handler.modifiers).toEqual(["Mod"]); expect(handler.key).toBe("a");
    for (const modifier of ["ctrlKey", "metaKey"]) {
      const event = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true, [modifier]: true }); child.contentDOM.dispatchEvent(event);
      child.dispatch({ selection: { anchor: 2 } }); expect(handler.callback(event)).toBe(false);
      expect(child.state.selection.main.from).toBe(0); expect(child.state.selection.main.to).toBe(child.state.doc.length);
    }
    child.dispatch({ selection: { anchor: 2 } });
    const outside = new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }); h.view.contentDOM.dispatchEvent(outside);
    expect(handler.callback(outside)).toBeUndefined(); expect(child.state.selection.main.head).toBe(2);
    expect(h.view.state.selection.eq(parentSelection)).toBe(true); expect(h.view.state.doc.toString()).toBe(marker);
  });

  it("pops each public key scope when a column closes or the host editor is destroyed", async () => {
    const h = runtime(marker); await settle(); const first = h.open(0)!; const firstScope = h.keyScopes[0]!;
    first.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await settle();
    expect(h.popScope).toHaveBeenCalledExactlyOnceWith(firstScope);
    h.open(1); const secondScope = h.keyScopes[1]!; expect(h.pushScope).toHaveBeenCalledTimes(2);
    h.view.destroy(); views.splice(views.indexOf(h.view), 1);
    expect(h.popScope).toHaveBeenCalledTimes(2); expect(h.popScope).toHaveBeenLastCalledWith(secondScope);
  });

  it("places the caret using the public embedded editor coordinate API", async () => {
    const h = runtime(marker); await settle();
    const coordinates = vi.spyOn(EditorView.prototype, "posAtCoords").mockReturnValue(2);
    const child = h.open(1, { clientX: 40, clientY: 60 })!;
    expect(coordinates).toHaveBeenCalledWith({ x: 40, y: 60 });
    expect(child.state.selection.main.head).toBe(2);
  });

  it("keeps read-only layouts rendered without opening a writable child editor", async () => {
    const h = runtime(marker, { readOnly: true }); await settle();
    expect(h.open(0)).toBeNull(); expect(h.widget()).not.toBeNull(); expect(h.view.state.doc.toString()).toBe(marker);
  });

  it("updates only the selected occurrence when duplicate columns contain identical text", async () => {
    const source = marker.replace("Right", "Left"); const h = runtime(source); await settle();
    const child = h.open(1)!; h.edit(child, 0, child.state.doc.length, "Second only");
    expect(h.view.state.doc.toString()).toBe(source.replace("%% col %%\nLeft", "%% col %%\nSecond only"));
  });

  it("opens the first column using Enter and closes the editor using Escape", async () => {
    const h = runtime(marker); await settle(); const widget = h.widget()!;
    expect(widget.getAttribute("role")).toBe("group"); expect(widget.tabIndex).toBe(0);
    widget.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const child = h.child()!; expect(child.state.doc.toString()).toBe("Left");
    h.edit(child, 0, 4, "Edited");
    child.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await settle();
    expect(h.child()).toBeNull(); expect(h.widget()).toBe(widget); expect(h.items()[0]!.textContent).toContain("Edited");
  });

  it("renders just the active column on blur and preserves its siblings", async () => {
    const h = runtime(marker); await settle(); const sibling = h.items()[1]!; const paragraph = sibling.querySelector("p");
    const child = h.open(0)!; h.edit(child, 0, 4, "After blur");
    const outside = document.createElement("button"); h.parent.append(outside); outside.focus(); await settle();
    expect(h.child()).toBeNull(); expect(h.items()[0]!.textContent).toContain("After blur");
    expect(h.items()[1]).toBe(sibling); expect(sibling.querySelector("p")).toBe(paragraph);
  });

  it("delegates undo and redo to the public parent editor and synchronizes the active editor", async () => {
    const h = runtime(marker); await settle(); const child = h.open(0)!; h.edit(child, 0, 4, "Changed");
    child.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", keyCode: 90, ctrlKey: true, bubbles: true, cancelable: true })); await settle();
    expect(h.undo).toHaveBeenCalledOnce(); expect(h.view.state.doc.toString()).toBe(marker); expect(h.child()?.state.doc.toString()).toBe("Left");
    h.child()!.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Z", code: "KeyZ", keyCode: 90, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); await settle();
    expect(h.redo).toHaveBeenCalledOnce(); expect(h.view.state.doc.toString()).toBe(marker.replace("Left", "Changed")); expect(h.child()?.state.doc.toString()).toBe("Changed");
  });

  it("rebases active item ranges after external edits before a layout", async () => {
    const source = `Before\n${marker}\nAfter`; const h = runtime(source); await settle(); const child = h.open(1)!;
    h.view.dispatch({ changes: { from: 0, insert: "Prefix\n" } }); await settle();
    expect(h.child()).toBe(child); h.edit(child, 0, 5, "Rebased");
    expect(h.view.state.doc.toString()).toBe(`Prefix\n${source.replace("Right", "Rebased")}`);
  });

  it("synchronizes external edits to the active column without writing them twice", async () => {
    const source = `Before\n${marker}\nAfter`; const h = runtime(source); await settle(); const child = h.open(1)!;
    const from = source.indexOf("Right");
    h.view.dispatch({ changes: { from, to: from + 5, insert: "External" } }); await settle();
    expect(h.child()).toBe(child); expect(child.state.doc.toString()).toBe("External");
    expect(h.view.state.doc.toString()).toBe(source.replace("Right", "External"));
    h.edit(child, child.state.doc.length, child.state.doc.length, "!");
    expect(h.view.state.doc.toString()).toBe(source.replace("Right", "External!"));
  });

  it("reconciles rejected parent transactions without displaying unsaved child text", async () => {
    const h = runtime(marker, { rejectHostEdits: true }); await settle(); const child = h.open(0)!;
    h.edit(child, 0, child.state.doc.length, "Rejected text"); await settle();
    expect(h.view.state.doc.toString()).toBe(marker); expect(child.state.doc.toString()).toBe("Left");
    expect(h.child()).toBe(child);
  });

  it("retains the composing editor DOM across composition input transactions", async () => {
    const h = runtime(marker); await settle(); const child = h.open(0)!; const content = child.contentDOM;
    content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    h.edit(child, 0, 4, "日本語");
    expect(h.child()).toBe(child); expect(h.child()?.contentDOM).toBe(content); expect(h.view.state.doc.toString()).toContain("日本語");
    content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本語" }));
  });

  it("preserves links, controls, modified clicks, and text selection", async () => {
    const h = runtime(marker); await settle();
    for (const selector of ["a", "button", "input", "textarea", "select", "summary", "[contenteditable=true]", ".colsdown-add-column", ".colsdown-resize-handle", ".internal-embed", ".cm-editor"]) {
      h.widget()!.querySelector(selector)!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); expect(h.child()).toBeNull();
    }
    const paragraph = h.widget()!.querySelector("p")!;
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      paragraph.dispatchEvent(new MouseEvent("click", { bubbles: true, ...modifiers })); expect(h.child()).toBeNull();
    }
    const range = document.createRange(); range.selectNodeContents(paragraph); window.getSelection()!.addRange(range);
    paragraph.dispatchEvent(new MouseEvent("click", { bubbles: true })); expect(h.child()).toBeNull();
  });

  it("saves typed text before disposal and unloads widget owners exactly once", async () => {
    const h = runtime(marker); await settle(); const owner = [...h.owners][0]!; const unload = vi.spyOn(owner, "unload");
    const child = h.open(1)!; h.edit(child, 0, 5, "Saved before close");
    expect(h.view.state.doc.toString()).toContain("Saved before close");
    h.view.destroy(); views.splice(views.indexOf(h.view), 1);
    expect(h.owners.size).toBe(0); expect(unload).toHaveBeenCalledOnce();
  });

  it("falls back after async failure and ignores late rejection after disposal", async () => {
    const error = new Error("Renderer failed"); const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = runtime(marker, { renderer: async () => { throw error; } }); await settle();
    expect(failed.widget()?.textContent).toContain("%% cols %%"); expect(log).toHaveBeenCalled();
    let reject: (error: Error) => void = () => {};
    const pending = runtime(marker, { renderer: () => new Promise((_resolve, fail) => { reject = fail; }) }); const widget = pending.widget()!;
    pending.view.destroy(); views.splice(views.indexOf(pending.view), 1); const before = widget.textContent;
    reject(error); await settle(); expect(widget.textContent).toBe(before); expect(pending.owners.size).toBe(0);
  });

  it("scans mixed layouts while leaving fenced examples, comments, and frontmatter native", () => {
    const nested = `%% cols %%\nLeft\n${fence}\n%% col %%\nRight\n%% endcols %%`;
    expect(mapping.scanEditorLayouts(nested).map((candidate) => candidate.syntax)).toEqual(["markers", "fenced"]);
    const source = `---\nexample: |\n${marker}\n---\n<!--\n${fence}\n-->\n\`\`\`text\n${marker}\n\`\`\`\n${nested}`;
    const found = mapping.scanEditorLayouts(source); expect(found).toHaveLength(2); expect(found[0]!.start).toBe(source.lastIndexOf(nested));
  });
});

describe("Marker Reading View", () => {
	let api: { layoutItemOffsets: (source: string, parsed: unknown, syntax: string) => number[]; registerMarkerReading: (plugin: unknown, renderer: unknown) => void; renderMarkerMarkdown: (...args: unknown[]) => Promise<void> };
	 api = require("../src/marker-rendering.cjs") as typeof api;

	const marker = "%% col-start %%\n%% col-break %%\nLeft\n%% col-break %%\nRight\n%% col-end %%";

	const tick = () => new Promise((resolve) => window.setTimeout(resolve, 0));

	function harness(source: string) {
	  let postprocess: (element: HTMLElement, context: unknown) => void = () => {};
	  const owners: ObsidianMock.MarkdownRenderChild[] = [];
	  const cleanup: Array<() => void> = [];
	  const render = vi.fn(async (_plugin, _markdown, target: HTMLElement, _context: unknown) => { target.textContent = "Rendered layout"; });
	  const plugin = { register: (callback: () => void) => cleanup.push(callback),
	    registerMarkdownPostProcessor: (callback: typeof postprocess) => { postprocess = callback; },
	    app: { vault: { getAbstractFileByPath: () => ({ path: "note.md" }), cachedRead: async () => source } } };
	  api.registerMarkerReading(plugin, render);
	  const container = document.createElement("div"); container.className = "markdown-preview-section";
	  document.body.appendChild(container);
	  const sections = new Map<HTMLElement, { lineStart: number; lineEnd: number }>();
	  const context = { sourcePath: "note.md", docId: "one", getSectionInfo: (element: HTMLElement) => ({ text: source, ...sections.get(element) }),
	    addChild: (owner: ObsidianMock.MarkdownRenderChild) => owners.push(owner) };
	  const section = (start: number, end: number, detached = false) => {
	    const element = document.createElement("div"); element.className = "el-p";
	    const native = document.createElement("p"); native.textContent = "Native"; element.append(native); if (!detached) container.append(element);
	    sections.set(element, { lineStart: start, lineEnd: end }); postprocess(element, context); return element;
	  };
	  return { section, render, container, owners, cleanup, update: (next: string, element: HTMLElement) => { source = next; postprocess(element, context); } };
	}

	describe("Reading View marker ownership", () => {
	  it("renders implicit first columns across ordinary preview sections", async () => {
	    const source = "%% cols %%\nFirst\n%% col %%\nSecond\n%% endcols %%";
	    const h = harness(source);
	    h.section(0, 1);
	    expect(h.render).not.toHaveBeenCalled();
	    h.section(2, 4);
	    await tick();
	    expect(h.render).toHaveBeenCalledTimes(1);
	    expect(h.container.querySelectorAll(".colsdown-marker-reading")).toHaveLength(1);
	  });
	  it.each(["\n", "\r\n"])("targets duplicate nested children correctly after an implicit opener (%j)", async (newline) => {
	    const source = `%% cols %%\n${marker}\n%% col %%\n${marker}\n%% endcols %%`.replace(/\n/g, newline);
	    const parse = (require("../src/markers.cjs") as { parseMarkerLayout: (source: string) => { items: Array<{ markdown: string }> } }).parseMarkerLayout;
	    const child = marker.replace(/\n/g, newline);
	    const first = source.indexOf(child);
	    const second = source.indexOf(child, first + child.length);
	    const parsed = parse(source);
	    const offsets = api.layoutItemOffsets(source, parsed, "markers");
	    expect(offsets).toEqual([first, second]);
	    const owner = new ObsidianMock.MarkdownRenderChild(document.createElement("div"));
	    const render = vi.fn(async () => {});
	    for (const [index, item] of parsed.items.entries()) {
	      await api.renderMarkerMarkdown({}, item.markdown, owner.containerEl, {
	        sourcePath: "note.md", layoutHandle: { syntax: "markers", source, snapshot: source, location: { lineStart: 0, lineEnd: 14 } },
	        layoutItemOffset: offsets[index], layoutSource: source,
	      }, owner, render);
	    }
	    const context = (render.mock.calls[1] as unknown[])[3];
	    const childSource = (render.mock.calls[1] as unknown[])[1] as string;
	    const edits = require("../src/source-edits.cjs") as {
	      prepareSourceEdit: (...args: unknown[]) => Promise<unknown>;
	      commitAddedColumn: (app: unknown, prepared: unknown) => Promise<{ source: string }>;
	    };
	    let current = source;
	    const file = { path: "note.md" };
	    const app = { vault: { getAbstractFileByPath: () => file, read: async () => current,
	      process: async (_file: unknown, update: (source: string) => string) => { current = update(current); } },
	      workspace: { getLeavesOfType: () => [] } };
	    const prepared = await edits.prepareSourceEdit(app, context, {}, childSource, ":::");
	    const saved = await edits.commitAddedColumn(app, prepared);
	    expect(current).toBe(source.slice(0, second) + saved.source + source.slice(second + childSource.length));
	    expect(parse(saved.source).items).toHaveLength(3);
	    expect(current.slice(0, second)).toBe(source.slice(0, second));
	  });
	  it("registers sections processed while detached once Obsidian mounts them", async () => {
	    const h = harness(marker);
	    const first = h.section(0, 2, true); const second = h.section(3, 5, true);
	    expect(h.render).not.toHaveBeenCalled();
	    h.container.append(first, second); await tick();
	    expect(h.render).toHaveBeenCalledTimes(1);
	    expect(h.container.querySelectorAll(".colsdown-marker-reading")).toHaveLength(1);
	    expect(first.querySelector("p")?.hidden).toBe(true);
	  });
	  it("cancels detached registration when the section unloads before mounting", async () => {
	    const h = harness(marker); const section = h.section(0, 5, true);
	    h.owners[0]?.unload(); h.container.append(section); await tick();
	    expect(h.render).not.toHaveBeenCalled();
	  });
	  it("waits for all sections, renders exactly once and restores native nodes on unload", async () => {
	    const h = harness(marker); const first = h.section(0, 2); expect(h.render).not.toHaveBeenCalled();
	    const second = h.section(3, 5); await tick();
	    expect(h.render).toHaveBeenCalledTimes(1);
	    expect(first.querySelector("p")?.hidden).toBe(true); expect(second.querySelector("p")?.hidden).toBe(true);
	    h.owners[1]?.unload();
	    expect(first.querySelector("p")?.hidden).toBe(false); expect(h.container.querySelector(".colsdown-marker-reading")).toBeNull();
	  });
	  it("keeps native content when asynchronous rendering fails", async () => {
	    const error = vi.spyOn(console, "error").mockImplementation(() => {});
	    const h = harness(marker); h.render.mockRejectedValueOnce(new Error("render rejected"));
	    const section = h.section(0, 5); await tick();
	    expect(section.querySelector("p")?.hidden).toBe(false);
	    expect(section.querySelector(".colsdown-marker-reading")).toBeNull();
	    expect(error).toHaveBeenCalledWith("Colsdown failed to render marker columns.", expect.any(Error));
	  });
	  it("keeps the replacement record when an obsolete render rejects later", async () => {
	    vi.spyOn(console, "error").mockImplementation(() => {});
	    let rejectOld: (error: Error) => void = () => {};
	    const old = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
	    const h = harness(marker);
	    h.render.mockImplementationOnce(() => old);
	    const section = h.section(0, 5);
	    h.update(marker.replace("Left", "Changed"), section); await tick();
	    rejectOld(new Error("obsolete render rejected")); await tick();
	    h.update(marker.replace("Left", "Changed"), section); await tick();
	    expect(h.render).toHaveBeenCalledTimes(2);
	    expect(h.container.querySelectorAll(".colsdown-marker-reading")).toHaveLength(1);
	  });
	  it("renders consecutive regions in one paragraph without losing surrounding text", async () => {
	    const source = `Before\n${marker}\n${marker}\nAfter`;
	    const h = harness(source); h.section(0, source.split("\n").length - 1); await tick();
	    expect(h.render).toHaveBeenCalledTimes(2);
	    expect(h.container.querySelectorAll(".colsdown-marker-reading")).toHaveLength(1);
	  });
	  it("retains registered sections when only an outside paragraph changes", async () => {
	    const h = harness(`${marker}\n\nAfter`); h.section(0, 5); const after = h.section(7, 7); await tick();
	    h.update(`${marker}\n\nChanged`, after); await tick(); expect(h.render).toHaveBeenCalledTimes(2);
	    expect(h.container.querySelectorAll(".colsdown-marker-reading")).toHaveLength(1);
	  });
	  it("uses fresh disk snapshots for external definition refreshes", async () => {
	    const h = harness(`${marker}\n\n[^note]: Old`); h.section(0, 5); await tick();
	    const context = h.render.mock.calls[0]?.[3] as { layoutHandle: { getSnapshot: () => Promise<string> } };
	    const outside = h.section(7, 7);
	    h.update(`${marker}\n\n[^note]: New`, outside);
	    expect(await context.layoutHandle.getSnapshot()).toContain("[^note]: New");
	  });
	  it("hydrates a reference before a nested layout with definitions from the trailing segment", async () => {
	    const markdown = `Reference[^shared]\n\n${marker}\n\n[^shared]: Shared definition`;
	    const renderMarkdown = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
	    const owner = new ObsidianMock.MarkdownRenderChild(document.createElement("div"));
	    await api.renderMarkerMarkdown({}, markdown, owner.containerEl, {}, owner, vi.fn(async () => {}));
	    const prelude = renderMarkdown.mock.calls.find((call) => call[1].includes("Reference[^shared]"));
	    expect(prelude?.[1]).toContain("[^shared]: Shared definition");
	    expect(markdown).toBe(`Reference[^shared]\n\n${marker}\n\n[^shared]: Shared definition`);
	  });
  it.each(["markers", "fenced"])("renders nested %s layouts between thematic breaks in a column fragment", async (syntax) => {
    const nested = syntax === "markers" ? marker : "```colsdown\nLeft\n:::\nRight\n```";
    const markdown = `---\n\n${nested}\n\n---`;
    const render = vi.fn(async () => {}); const owner = new ObsidianMock.MarkdownRenderChild(document.createElement("div"));
    try {
      await api.renderMarkerMarkdown({}, markdown, owner.containerEl, {}, owner, render);
      expect(render).toHaveBeenCalledOnce(); expect((render.mock.calls[0] as unknown[])[1]).toBe(syntax === "markers" ? `${nested}\n` : "Left\n:::\nRight\n");
    } finally { owner.unload(); }
  });

  it.each(["```text\nUnclosed code", "<!--\nUnclosed comment", "%%\nUnclosed comment"])("maps nested source from original Markdown when external footnotes require a prefix before %j", async (suffix) => {
    const footnotes = require("../src/footnotes.cjs") as { hydrateFootnotes: (source: string, definitions: Map<string, string>) => string };
    const original = `Reference[^shared]\n\n${marker}\n\n${suffix}`;
    const snapshot = `Before\n${original}`;
    const hydrated = footnotes.hydrateFootnotes(original, new Map([["shared", "[^shared]: External definition."]]));
    expect(hydrated.indexOf("[^shared]:")).toBeLessThan(hydrated.indexOf("Reference[^shared]"));
    const render = vi.fn(async () => {}); const owner = new ObsidianMock.MarkdownRenderChild(document.createElement("div"));
    try {
      await api.renderMarkerMarkdown({}, hydrated, owner.containerEl, {
        sourcePath: "note.md", layoutOriginalMarkdown: original,
        renderSectionInfo: { text: snapshot, lineStart: 1, lineEnd: snapshot.split("\n").length - 1 },
      }, owner, render);
      expect(render).toHaveBeenCalledOnce();
      const context = (render.mock.calls[0] as unknown[])[3] as { layoutHandle: { start: number; source: string; location: { lineStart: number } } };
      expect(context.layoutHandle.start).toBe(snapshot.indexOf(marker)); expect(context.layoutHandle.source).toBe(`${marker}\n`);
      expect(context.layoutHandle.location.lineStart).toBe(3); expect(context).not.toHaveProperty("layoutOriginalMarkdown");
    } finally { owner.unload(); }
  });

  it("preserves reference links and images before and after a nested layout, including multiline definitions", async () => {
    const references = require("../src/footnotes.cjs") as { collectReferenceDefinitions: (source: string, options?: { fragment?: boolean }) => Map<string, string> };
    const docs = '[Docs]: <https://example.com/docs>\n  "Documentation\n  second line"';
    const image = '[image]: https://example.com/image.png "Image title"';
    const markdown = `${docs}\n\nBefore [guide][Docs] and ![image][image].\n\n${marker}\n\nAfter [guide][Docs] and ![image][image].\n\n${image}`;
    const rendered = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
    const owner = new ObsidianMock.MarkdownRenderChild(document.createElement("div"));
    try {
      await api.renderMarkerMarkdown({}, markdown, owner.containerEl, {}, owner, vi.fn(async () => {}));
      const before = rendered.mock.calls.find((call) => call[1].includes("Before [guide]"))![1];
      const after = rendered.mock.calls.find((call) => call[1].includes("After [guide]"))![1];
      for (const segment of [before, after]) {
        expect(segment).toContain(docs); expect(segment).toContain(image);
        const resolved = references.collectReferenceDefinitions(segment, { fragment: true });
        expect(resolved.size).toBe(2); expect(resolved.get("docs")).toContain(docs); expect(resolved.get("image")).toContain(image);
      }
    } finally { owner.unload(); }
  });

  it("keeps the original first reference definition authoritative on both sides of a nested layout", async () => {
    const definitions = require("../src/footnotes.cjs") as { collectReferenceDefinitions: (source: string, options?: { fragment?: boolean }) => Map<string, string> };
    const first = "[Docs]: https://example.com/first";
    const markdown = `${first}\n\nBefore [guide][Docs].\n\n${marker}\n\nAfter [guide][docs].\n\n[docs]: https://example.com/later`;
    const rendered = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
    const owner = new ObsidianMock.MarkdownRenderChild(document.createElement("div"));
    try {
      await api.renderMarkerMarkdown({}, markdown, owner.containerEl, {}, owner, vi.fn(async () => {}));
      const segments = rendered.mock.calls.filter((call) => /(?:Before|After) \[guide\]/.test(call[1]));
      expect(segments).toHaveLength(2);
      for (const call of segments) expect(definitions.collectReferenceDefinitions(call[1], { fragment: true }).get("docs")).toContain(first);
    } finally { owner.unload(); }
  });

	  it("uses break body offsets when an ignored marker prelude duplicates a displayed child", async () => {
	    const source = `%% col-start %%\n${marker}\n%% col-break %%\n${marker}\n%% col-end %%`;
	    const parse = (require("../src/markers.cjs") as { parseMarkerLayout: (source: string) => { items: Array<{ markdown: string }> } }).parseMarkerLayout;
	    const parsed = parse(source);
	    const offsets = api.layoutItemOffsets(source, parsed, "markers");
	    const displayedStart = source.lastIndexOf(marker);
	    expect(offsets).toEqual([displayedStart]);
	    const render = vi.fn(async () => {});
	    const owner = new ObsidianMock.MarkdownRenderChild(document.createElement("div"));
	    await api.renderMarkerMarkdown({}, parsed.items[0]?.markdown, owner.containerEl, {
	      layoutHandle: { source, snapshot: source, location: { lineStart: 0, lineEnd: 15 } },
	      layoutItemOffset: offsets[0], layoutSource: source,
	    }, owner, render);
	    expect((render.mock.calls[0] as unknown[])[3]).toMatchObject({
	      layoutHandle: { location: { lineStart: source.slice(0, displayedStart).split("\n").length - 1 } },
	    });
	  });
	  it("recreates a coordinator after its final section unloads", async () => {
	    const h = harness(marker); h.section(0, 5); await tick();
	    h.owners[0]?.unload(); h.section(0, 5); await tick();
	    expect(h.render).toHaveBeenCalledTimes(2);
	    expect(h.container.querySelectorAll(".colsdown-marker-reading")).toHaveLength(1);
	  });
	  it("maps normalized fenced Markdown to exact CRLF marker lines", async () => {
	    const snapshot = `\`\`\`colsdown\r\n${marker.replace(/\n/g, "\r\n")}\r\n\`\`\``;
	    const render = vi.fn(async () => {});
	    const owner = new ObsidianMock.MarkdownRenderChild(document.createElement("div"));
	    await api.renderMarkerMarkdown({}, marker, owner.containerEl, {
	      sourcePath: "note.md", renderSectionInfo: { text: snapshot, lineStart: 0, lineEnd: 6 },
	      layoutItemOffset: 0, layoutSource: marker,
	    }, owner, render);
	    expect((render.mock.calls[0] as unknown[])[3]).toMatchObject({ layoutHandle: { location: { lineStart: 1, lineEnd: 6 } } });
	    expect((render.mock.calls[0] as unknown[])[1]).toContain("\r\n");
	  });
	  it("maps identical nested children using their exact item offsets", async () => {
	    const source = `%% col-start %%\n%% col-break %%\n${marker}\n%% col-break %%\n${marker}\n%% col-end %%`;
	    const render = vi.fn(async () => {}); const owner = new ObsidianMock.MarkdownRenderChild(document.createElement("div"));
	    const first = source.indexOf(marker); const second = source.indexOf(marker, first + marker.length);
	    for (const offset of [first, second]) await api.renderMarkerMarkdown({}, marker, owner.containerEl, {
	      sourcePath: "note.md", layoutHandle: { source, snapshot: source, location: { lineStart: 0, lineEnd: 15 } }, layoutItemOffset: offset,
	    }, owner, render);
	    expect(render.mock.calls.map((call) => (call as unknown[])[3])).toMatchObject([
	      { layoutHandle: { location: { lineStart: 2 } } }, { layoutHandle: { location: { lineStart: 9 } } },
	    ]);
	  });
	});
});

describe("Marker source edits", () => {
	type Saved = { source: string; snapshot: string; location: { lineStart: number; lineEnd: number } };

	const { rewriteLayoutWidths, appendAutoColumn, prepareSourceEdit, commitWidths, commitAddedColumn } = require("../src/source-edits.cjs") as {
	  rewriteLayoutWidths: (source: string, widths: number[], separator: string, syntax: string) => string;
	  appendAutoColumn: (source: string, separator: string, syntax: string) => string;
	  prepareSourceEdit: (app: unknown, context: unknown, element: unknown, source: string, separator: string) => Promise<unknown>;
	  commitWidths: (app: unknown, prepared: unknown, widths: number[]) => Promise<Saved>;
	  commitAddedColumn: (app: unknown, prepared: unknown) => Promise<Saved>;
	};

	const { parseMarkerLayout } = require("../src/markers.cjs") as {
	  parseMarkerLayout: (source: string) => { items: { width: { kind: string; value?: number }; markdown: string }[] };
	};

	const region = "%% col-start:unknown %%\nignored\n%% col-break:40:keep:yes %%\nLeft\n%% col-break:w:60:custom %%\nRight\n%% col-end %%";

	function fixture(initial: string) {
	  let text = initial;
	  const file = { path: "note.md" };
	  const app = {
	    vault: {
	      getAbstractFileByPath: () => file,
	      read: vi.fn(async () => text),
	      process: vi.fn(async (_file: unknown, update: (source: string) => string) => { text = update(text); }),
	    },
	    workspace: { getLeavesOfType: vi.fn(() => [] as unknown[]) },
	  };
	  const context = (source = region, location?: Saved["location"]) => ({
	    sourcePath: file.path,
	    layoutHandle: { syntax: "markers", direction: "row", source, location },
	  });
	  return { app, context, text: () => text, set: (value: string) => { text = value; } };
	}

	describe("marker source edits", () => {
	  it("rewrites widths without changing unknown tokens, CRLF, or nested layouts", () => {
	    const child = "%% col-start %%\n%% col-break:25 %%\nNested\n%% col-end %%";
	    const source = region.replace("Left", child).replace(/\n/g, "\r\n");
	    const updated = rewriteLayoutWidths(source, [30, 70], "IGNORED", "markers");
	    expect(updated).toBe(source.replace(":40:keep", ":30:keep").replace(":w:60:custom", ":70:custom"));
	    expect(updated).toContain(child.replace(/\n/g, "\r\n"));
	    expect(() => rewriteLayoutWidths(source, [20, 20], ":::", "markers")).toThrow("add up to 100%");
	  });
	  it("preserves comma-delimited unknown tokens when resizing", () => {
	    const source = region.replace(":40:keep:yes", ":40,b:blue-soft").replace(":w:60:custom", ":w:60,custom:token");
	    expect(rewriteLayoutWidths(source, [35, 65], ":::", "markers")).toBe(source.replace(":40,", ":35,").replace(":w:60,", ":65,"));
	  });
	  it("canonicalizes legacy width tokens while preserving marker whitespace and metadata", () => {
	    const source = region
	      .replace("%% col-break:40:keep:yes %%", "  %%\tcol-break:w:40:keep:yes \t%%\t")
	      .replace(":w:60:custom", ":w:60,custom:token")
	      .replace(/\n/g, "\r\n");
	    const updated = rewriteLayoutWidths(source, [37.5, 62.5], ":::", "markers");
	    expect(updated).toBe(source.replace(":w:40:", ":37.5:").replace(":w:60,", ":62.5,"));
	    expect(updated).not.toContain(":w:");
	    expect(parseMarkerLayout(updated).items.map((item) => item.width.value)).toEqual([37.5, 62.5]);
	  });
	  it("does not mistake numeric values in unknown tokens for widths", () => {
	    const source = region.replace(":40:keep:yes", ":unknown:40").replace(":w:60:custom", ":unknown:60");
	    expect(parseMarkerLayout(source).items.every((item) => item.width.kind === "auto")).toBe(true);
	    const saved = rewriteLayoutWidths(source, [35, 65], ":::", "markers");
	    expect(saved).toContain(":35:unknown:40");
	    expect(saved).toContain(":65:unknown:60");
	  });
	  it("adds before the end marker and reserves space from all-percent columns", () => {
	    const updated = appendAutoColumn(region, "IGNORED", "markers");
	    const items = parseMarkerLayout(updated).items;
	    expect(items).toHaveLength(3);
	    expect(items[0]!.width.value).toBeCloseTo(26.6667);
	    expect(items[1]!.width.value).toBe(40);
	    expect(items[2]).toEqual({ width: { kind: "auto" }, markdown: "New column\n" });
	    expect(updated).toContain(":keep:yes");
	    expect(updated).not.toContain(":w:");
	    expect(updated.endsWith("%% col-end %%")).toBe(true);
	    expect(() => appendAutoColumn("%% col-start %%\nAfter", ":::", "markers")).toThrow("incomplete");
	  });
	  it("resizes and appends compact columns without changing family, nested source, metadata, or CRLF", () => {
	    const nested = region.replace(/\n/g, "\r\n");
	    const source = `%% cols:unknown %%\r\n  %%\tcol:40:unknown:90 \t%%\t\r\n${nested}\r\n%% col:w:60,keep:12 %%\r\nRight\r\n%% endcols %%\r\n`;
	    const resized = rewriteLayoutWidths(source, [35, 65], ":::", "markers");
	    expect(resized).toBe(source.replace(":40:unknown:90", ":35:unknown:90").replace(":w:60,keep:12", ":65,keep:12"));
	    const appended = appendAutoColumn(resized, ":::", "markers");
	    expect(appended).toContain(nested);
	    expect(appended).toContain("%% col %%\r\nNew column\r\n%% endcols %%\r\n");
	    const items = parseMarkerLayout(appended).items;
	    expect(items).toHaveLength(3);
	    expect(items[0]!.width.value).toBeCloseTo(23.3333);
	    expect(items[1]!.width.value).toBeCloseTo(43.3333);
	    expect(items[2]!.width.kind).toBe("auto");
	    expect(appended.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
	  });
	  it("saves implicit widths through real boundaries without rewriting the opener or nested content", () => {
	    const child = region.replace(/\n/g, "\r\n");
	    const source = `%% cols:unknown %%\r\n${child}\r\n%% col:w:60,keep:9 %%\r\nRight\r\n%% col:20:other:8 %%\r\nLast\r\n%% endcols %%\r\n`;
	    const resized = rewriteLayoutWidths(source, [25, 35, 40], ":::", "markers");
	    expect(resized).toBe(source.replace(":w:60,keep:9", ":35,keep:9").replace(":20:other:8", ":40:other:8"));
	    expect(parseMarkerLayout(resized).items.map((item) => item.width)).toEqual([{ kind: "auto" }, { kind: "percent", value: 35 }, { kind: "percent", value: 40 }]);
	    expect(parseMarkerLayout(resized).items[0]!.markdown).toBe(`${child}\r\n`);
	    expect(appendAutoColumn(resized, ":::", "markers")).toContain("%% col %%\r\nNew column\r\n%% endcols %%\r\n");
	  });
	  it("appends to a compact single column without adding a redundant first boundary", () => {
	    const source = "%% cols %%\nOnly column\n%% endcols %%";
	    expect(rewriteLayoutWidths(source, [100], ":::", "markers")).toBe(source);
	    const updated = appendAutoColumn(source, ":::", "markers");
	    expect(updated).toBe("%% cols %%\nOnly column\n%% col %%\nNew column\n%% endcols %%");
	    expect(parseMarkerLayout(updated).items.map((item) => item.markdown)).toEqual(["Only column\n", "New column\n"]);
	  });
	  it.each(["", " \r\n\t\r\n"])("preserves an empty implicit column when appending (%j)", (content) => {
	    const source = `%% cols %%\r\n${content}%% endcols %%\r\n`;
	    const updated = appendAutoColumn(source, ":::", "markers");
	    expect(updated).toBe(`%% cols %%\r\n%% col %%\r\n${content}%% col %%\r\nNew column\r\n%% endcols %%\r\n`);
	    expect(parseMarkerLayout(updated).items.map((item) => item.markdown)).toEqual([content, "New column\r\n"]);
	  });
	  it("keeps fractional/auto source while appending", () => {
	    const source = region.replace(":40", ":2fr").replace(":w:60", "");
	    const updated = appendAutoColumn(source, ":::", "markers");
	    expect(updated).toContain("col-break:2fr:keep:yes");
	    expect(parseMarkerLayout(updated).items).toHaveLength(3);
	  });
	  it("selects duplicate regions by exact location and returns the full saved source", async () => {
	    const f = fixture(`Before\n${region}\nMiddle\n${region}\nAfter`);
	    const location = { lineStart: 9, lineEnd: 15 };
	    const prepared = await prepareSourceEdit(f.app, f.context(region, location), {}, "unused", ":::");
	    const saved = await commitWidths(f.app, prepared, [30, 70]);
	    expect(f.text()).toBe(`Before\n${region}\nMiddle\n${saved.source}After`);
	    expect(saved.source.startsWith("%% col-start")).toBe(true);
	    const next = await prepareSourceEdit(f.app, f.context(saved.source, saved.location), {}, saved.source, ":::");
	    const added = await commitAddedColumn(f.app, next);
	    expect(parseMarkerLayout(added.source).items).toHaveLength(3);
	    expect(f.text()).toContain(`Before\n${region}\nMiddle\n`);
	  });
	  it("rejects ambiguous, stale location and compare-and-swap conflicts", async () => {
	    const f = fixture(`${region}\n${region}`);
	    await expect(prepareSourceEdit(f.app, f.context(), {}, region, ":::")).rejects.toThrow("multiple identical");
	    await expect(prepareSourceEdit(f.app, f.context(region, { lineStart: 20, lineEnd: 26 }), {}, region, ":::")).rejects.toThrow("exact source match");
	    const prepared = await prepareSourceEdit(f.app, f.context(region, { lineStart: 0, lineEnd: 6 }), {}, region, ":::");
	    f.set(`${f.text()}\nExternal edit`);
	    await expect(commitWidths(f.app, prepared, [30, 70])).rejects.toThrow("note changed");
	  });
	  it("uses one public editor transaction and rejects editing-mode changes", async () => {
	    const f = fixture(`Before\n${region}\nAfter`);
	    const transaction = vi.fn();
	    const editor = { getValue: f.text, transaction };
	    f.app.workspace.getLeavesOfType.mockReturnValue([{ view: { file: f.app.vault.getAbstractFileByPath(), getMode: () => "source", editor } }]);
	    const prepared = await prepareSourceEdit(f.app, f.context(region, { lineStart: 1, lineEnd: 7 }), {}, region, ":::");
	    const saved = await commitWidths(f.app, prepared, [30, 70]);
	    expect(transaction).toHaveBeenCalledExactlyOnceWith({ changes: [{ from: { line: 1, ch: 0 }, to: { line: 8, ch: 0 }, text: saved.source }] });
	    expect(f.app.vault.process).not.toHaveBeenCalled();
	    f.app.workspace.getLeavesOfType.mockReturnValue([]);
	    await expect(commitWidths(f.app, prepared, [30, 70])).rejects.toThrow("mode changed");
	  });
	  it("preserves final newlines while appending with CRLF", () => {
	    const source = `${region.replace(/\n/g, "\r\n")}\r\n`;
	    const updated = appendAutoColumn(source, ":::", "markers");
	    expect(updated.endsWith("%% col-end %%\r\n")).toBe(true);
	    expect(updated).toContain("%% col-break %%\r\nNew column\r\n%% col-end");
	    expect(updated.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
	  });
	  it("edits a nested region without touching its parent widths", async () => {
	    const child = region;
	    const parent = `%% col-start %%\n%% col-break:50 %%\n${child}\n%% col-break:50 %%\nOther\n%% col-end %%`;
	    const f = fixture(parent);
	    const prepared = await prepareSourceEdit(f.app, f.context(child, { lineStart: 2, lineEnd: 8 }), {}, child, ":::");
	    const saved = await commitWidths(f.app, prepared, [30, 70]);
	    expect(f.text()).toBe(parent.replace(`${child}\n`, saved.source));
	    expect(parseMarkerLayout(f.text()).items.map((item) => item.width.value)).toEqual([50, 50]);
	  });
	});
});

describe("Marker footnote integration", () => {
	interface Location { lineStart: number; lineEnd: number }

	interface Handle {
		syntax: "markers";
		location?: Location;
		snapshot?: string;
		getSnapshot?: () => string | null;
	}

	interface Mapping {
		language: string;
		syntax?: string;
		direction?: string;
		previousLocation: Location;
		location: Location;
		previousSource: string;
		source: string;
	}

	const { readFootnoteDefinitions, mapFootnoteLayouts } = require("../src/footnotes.cjs") as {
		readFootnoteDefinitions: (app: unknown, context: unknown, element: HTMLElement, source: string,
			direction: string, location?: Location | null) => Promise<{ definitions: Map<string, string>; location: Location; snapshot: string } | null>;
		mapFootnoteLayouts: (previous: string, next: string) => Mapping[];
	};

	const marker = (first = "Text[^shared].", second = "Sibling.") =>
		`%% col-start %%\n%% col-break %%\n${first}\n%% col-break %%\n${second}\n%% col-end %%`;

	function fixture(note: string, handle: Handle) {
		const file = { path: "Marker.md" };
		const vault = { cachedRead: vi.fn(async () => note), getAbstractFileByPath: () => file };
		const context = { sourcePath: file.path, layoutHandle: handle };
		return { vault, read: (source: string, location: Location | null = null) =>
			readFootnoteDefinitions({ vault }, context, document.createElement("div"), source, "row", location) };
	}

	describe("marker footnote source validation", () => {
	  it("hydrates an implicit first column and a single-column compact layout", async () => {
	    for (const sibling of ["", "\n%% col %%\nSibling."]) {
	      const source = `%% cols %%\nText[^shared].${sibling}\n%% endcols %%`;
	      const note = `${source}\n\n[^shared]: Shared outside the implicit layout.`;
	      const test = fixture(note, { syntax: "markers", location: { lineStart: 0, lineEnd: source.split("\n").length - 1 } });
	      expect((await test.read(source))?.definitions.get("shared")).toContain("Shared outside the implicit layout.");
	    }
	  });
		it("uses unsaved definitions in sibling columns and refreshes from the current editor document", async () => {
			const source = marker("Text[^shared].", "[^shared]: Unsaved sibling.");
			let snapshot = source;
			const test = fixture(marker("Text[^shared].", "[^shared]: Stale disk."), {
				syntax: "markers", location: { lineStart: 0, lineEnd: 5 }, getSnapshot: () => snapshot,
			});
			const result = await test.read(source);
			expect(result?.definitions.get("shared")).toContain("Unsaved sibling.");
			expect(result?.snapshot).toBe(snapshot);
			snapshot = `${source}\n\n[^outside]: Newly typed definition.`;
			const updated = await test.read(source);
			expect(updated?.definitions.get("outside")).toContain("Newly typed definition.");
			expect(updated?.snapshot).toBe(snapshot);
			expect(test.vault.cachedRead).not.toHaveBeenCalled();
		});

		it("uses supplied marker snapshot for validation and fails closed if its getter becomes unavailable", async () => {
			const source = marker();
			const handle: Handle = { syntax: "markers", snapshot: `${source}\n\n[^shared]: Editor definition.` };
			const test = fixture("Unrelated disk.", handle);
			expect((await test.read(source))?.definitions.get("shared")).toContain("Editor definition.");
			handle.getSnapshot = () => null;
			expect(await test.read(source)).toBeNull();
			expect(test.vault.cachedRead).not.toHaveBeenCalled();
		});

		it("requires exact location for duplicate marker layouts", async () => {
			const source = marker();
			const note = `${source}\n\n${source}\n\n[^shared]: Shared.`;
			const handle: Handle = { syntax: "markers" };
			const test = fixture(note, handle);
			expect(await test.read(source)).toBeNull();
			handle.location = { lineStart: 7, lineEnd: 12 };
			expect((await test.read(source))?.location).toEqual(handle.location);
			expect(await test.read(source, { lineStart: 6, lineEnd: 12 })).toBeNull();
		});

		it("finds markers inside layout fences but does not hydrate fenced example markers", async () => {
			const source = marker();
			const note = `\`\`\`\`colsdown\n${source}\n\`\`\`\`\n\n[^shared]: Nested.`;
			const test = fixture(note, { syntax: "markers", location: { lineStart: 1, lineEnd: 6 } });
			expect((await test.read(source))?.definitions.get("shared")).toContain("Nested.");
			const example = fixture(`\`\`\`markdown\n${source}\n\`\`\`\n\n[^shared]: Example.`, { syntax: "markers" });
			expect(await example.read(source)).toBeNull();
		});

		it("keeps syntax identity when a fenced body resembles a complete marker region", async () => {
			const source = marker();
			const test = fixture(`\`\`\`colsdown\n${source}\n\`\`\`\n\n[^shared]: Nested.`, {
				syntax: "markers", location: { lineStart: 0, lineEnd: 7 },
			});
			expect(await test.read(source)).toBeNull();
		});
	});

	describe("mixed layout footnote refresh mapping", () => {
		it("maps ancestors, nested markers, fences and later siblings after adding a column", () => {
			const nested = marker("Nested[^shared].");
			const fence = "```stack\nFirst[^shared].\n:::\nSecond\n```";
			const parent = marker(nested, fence);
			const sibling = marker("Later[^shared].");
			const previous = `${parent}\n\n${sibling}\n\n[^shared]: Shared.`;
			const changedNested = nested.replace("%% col-end %%", "%% col-break %%\nNew column\n%% col-end %%");
			const next = previous.replace(nested, changedNested);
			const mappings = mapFootnoteLayouts(previous, next);
			expect(mappings).toHaveLength(4);
			expect(mappings.map((item) => item.syntax ?? "fenced")).toEqual(["markers", "markers", "fenced", "markers"]);
			expect(mappings[0]?.source).toContain(changedNested);
			expect(mappings[1]?.source.trimEnd()).toBe(changedNested);
			expect(mappings[2]?.source).toBe("First[^shared].\n:::\nSecond\n");
			expect(mappings[3]?.source.trimEnd()).toBe(sibling);
			for (const mapping of mappings.slice(2)) {
				expect(mapping.location.lineStart).toBe(mapping.previousLocation.lineStart + 2);
			}
		});

		it("maps width updates without losing unknown marker metadata or sibling source", () => {
			const first = marker().replace("col-break", "col-break:40:unknown:keep");
			const note = `${first}\n\n${marker("Sibling[^shared].")}`;
			const mappings = mapFootnoteLayouts(note, note.replace(":40:", ":w:45:"));
			expect(mappings).toHaveLength(2);
			expect(mappings[0]?.source).toContain(":w:45:unknown:keep");
			expect(mappings[1]?.source).toBe(mappings[1]?.previousSource);
			expect(mappings[0]?.direction).toBe("row");
		});

		it("rejects mapping across a syntax or direction change", () => {
			const source = marker();
			expect(mapFootnoteLayouts(source, source.replace("col-start", "col-start:l:stack"))).toEqual([]);
			expect(mapFootnoteLayouts(source, "```colsdown\nText[^shared].\n:::\nSibling.\n```" )).toEqual([]);
		});
	});

	interface RenderRecord {
	  refresh: () => Promise<void>;
	  sourceEdited: (updated: string, saved: unknown, direct?: boolean) => void;
	}

	interface RenderPlugin {
	  app: unknown;
	  settings: { separator: string };
	  activeFootnoteRenders?: Set<RenderRecord>;
	}

	let renderLayout: (plugin: RenderPlugin, source: string, element: HTMLElement, context: unknown, direction: string) => Promise<void>;

	  ({ renderLayout } = require("../src/main.cjs") as { renderLayout: typeof renderLayout });

	it.each([
	  { newline: "\n", syntax: "markers" }, { newline: "\r\n", syntax: "markers" },
	  { newline: "\n", syntax: "fenced" }, { newline: "\r\n", syntax: "fenced" },
	])("maps rendered duplicate nested $syntax columns to exact editable source offsets ($newline)", async ({ newline, syntax }) => {
	  const child = (syntax === "markers" ? "%% cols %%\nRepeated\n%% col %%\nTail\n%% endcols %%" : "```colsdown\nRepeated\n:::\nTail\n```").replace(/\n/g, newline);
	  const parent = `\`\`\`\`colsdown${newline}${newline}:::${newline}${child}${newline}:::${newline}${child}${newline}\`\`\`\``;
	  const snapshot = `Before${newline}${parent}${newline}After`;
	  const { scanEditorLayouts } = require("../src/markers.cjs") as { scanEditorLayouts: (source: string) => Array<{ body: string }> };
	  const { markerContext } = require("../src/marker-rendering.cjs") as { markerContext: (context: unknown, candidate: unknown, snapshot: string) => object };
	  const candidate = scanEditorLayouts(snapshot)[0]!;
	  const children: ObsidianMock.MarkdownRenderChild[] = [];
	  const element = document.createElement("div");
	  const editableItems = new Map<HTMLElement, { from: number; to: number }>();
	  const inlineEditing = {
	    registerLayout: () => () => {},
	    registerItem: (item: { element: HTMLElement; from: number; to: number }) => {
	      editableItems.set(item.element, item); item.element.dataset.testInlineItem = "true";
	      return () => { editableItems.delete(item.element); delete item.element.dataset.testInlineItem; };
	    },
	  };
	  const context = markerContext({ sourcePath: "Note.md", inlineEditing,
	    addChild: (child: ObsidianMock.MarkdownRenderChild) => children.push(child) }, candidate, snapshot);
	  const renderer = vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, target) => {
	    target.textContent = markdown;
	  });
	  const plugin: RenderPlugin = { app: {}, settings: { separator: ":::" } };
	  try {
	    await renderLayout(plugin, candidate.body, element, context, "row");
	    const offsets = Array.from(element.querySelectorAll<HTMLElement>("[data-test-inline-item]"),
	      (item: HTMLElement) => editableItems.get(item)!.from);
	    expect(offsets).toEqual([
	      snapshot.indexOf(child), snapshot.indexOf("Repeated"), snapshot.indexOf("Tail"),
	      snapshot.lastIndexOf(child), snapshot.lastIndexOf("Repeated"), snapshot.lastIndexOf("Tail"),
	    ]);
	    const readonly = document.createElement("div");
	    const registeredCount = editableItems.size;
	    await renderLayout(plugin, candidate.body, readonly, { ...context, inlineEditing: undefined }, "row");
	    expect(readonly.querySelector("[data-test-inline-item]")).toBeNull();
	    expect(editableItems.size).toBe(registeredCount);
	    for (const item of editableItems.values()) {
	      expect(snapshot.slice(item.from, item.to).endsWith(newline)).toBe(false);
	    }
	  } finally {
	    children.reverse().forEach((child) => child.unload());
	    renderer.mockRestore();
	  }
	});


  it.each(["markers", "fenced"])("keeps nested %s auto columns side by side without changing top-level auto sizing", async (syntax) => {
    const body = syntax === "markers" ? "%% cols %%\nLeft\n%% col %%\nRight\n%% endcols %%" : "Left\n:::\nRight";
    const children: ObsidianMock.MarkdownRenderChild[] = [];
    const context = { sourcePath: "", layoutHandle: { syntax }, addChild: (child: ObsidianMock.MarkdownRenderChild) => children.push(child) };
    const plugin: RenderPlugin = { app: {}, settings: Object.assign({ separator: ":::" }, { minColumnWidthPx: 250, responsiveBreakpointPx: 464 }) };
    const top = document.createElement("div");
    const outer = document.createElement("div"); outer.className = "layout-columns-root";
    const nested = document.createElement("div"); outer.append(nested);
    const renderer = vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element) => { element.textContent = markdown; });
    try {
      await renderLayout(plugin, body, top, context, "row");
      await renderLayout(plugin, body, nested, context, "row");
      const topLayout = top.querySelector<HTMLElement>(".layout-layout")!;
      const nestedLayout = nested.querySelector<HTMLElement>(".layout-layout")!;
      expect(topLayout.style.gridTemplateColumns).toContain("min(100%, var(--layout-min-width))");
      expect(topLayout.classList.contains("layout-explicit")).toBe(false);
      expect(topLayout.classList.contains("layout-nested")).toBe(false);
      expect(nestedLayout.style.gridTemplateColumns).toBe("minmax(0, 1fr) minmax(0, 1fr)");
      expect(nestedLayout.classList.contains("layout-explicit")).toBe(true);
      expect(nestedLayout.classList.contains("layout-nested")).toBe(true);
    } finally { children.reverse().forEach((child) => child.unload()); renderer.mockRestore(); }
  });

	it("refreshes an existing sibling marker render after a preceding layout gains a column", async () => {
	  const first = marker("Earlier[^shared].");
	  const sibling = marker("Sibling[^shared].");
	  let note = `${first}\n\n${sibling}\n\n[^shared]: OLD shared definition.`;
	  const file = { path: "Marker.md" };
	  const plugin: RenderPlugin = {
	    app: { vault: { getAbstractFileByPath: () => file, cachedRead: async () => note },
	      workspace: { getLeavesOfType: () => [] } }, settings: { separator: ":::" },
	  };
	  const children: ObsidianMock.MarkdownRenderChild[] = [];
	  const element = document.createElement("div");
	  const handle: Handle & { source: string } = { syntax: "markers", source: sibling,
	    location: { lineStart: 7, lineEnd: 12 }, getSnapshot: () => note };
	  const renderer = vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, target) => {
	    target.textContent = markdown;
	  });
	  try {
	    await renderLayout(plugin, sibling, element, { sourcePath: file.path, layoutHandle: handle,
	      addChild: (child: ObsidianMock.MarkdownRenderChild) => children.push(child) }, "row");
	    expect(element.textContent).toContain("OLD shared definition.");
	    const previous = note;
	    note = note.replace(first, first.replace("%% col-end %%", "%% col-break %%\nNew column\n%% col-end %%"));
	    const record = [...plugin.activeFootnoteRenders ?? []][0];
	    record?.sourceEdited("", { layoutMappings: mapFootnoteLayouts(previous, note) });
	    note = note.replace("OLD shared", "NEW shared");
	    await record?.refresh();
	    expect(element.textContent).toContain("NEW shared definition.");
	    expect(element.textContent).not.toContain("OLD shared definition.");
	    expect(handle.location).toEqual({ lineStart: 9, lineEnd: 14 });
	  } finally {
	    children.reverse().forEach((child) => child.unload());
	    renderer.mockRestore();
	  }
	});
});

//#endregion

//#region Shared layout behavior

describe("Layout validation", () => {
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
});

describe("Resize controls", () => {
	interface ResizeOptions {
	 app: unknown; source: string; element: HTMLElement; layout: HTMLElement; context: unknown; separator: string;
	 child: { register(callback: () => void): void };
	 prepare: () => Promise<unknown>;
	 commit: (app: unknown, prepared: unknown, ratios: number[], separator: string) => Promise<{ source: string }>;
	}

	interface ResizeApi {
	 attachResizers(this: void, options: ResizeOptions): () => void;
	 resizeRatios(this: void, ratios: number[], index: number, position: number): number[] | null;
	}

	const { attachResizers, resizeRatios } = require("../src/resize.cjs") as ResizeApi;

	const disposers: Array<() => void> = [];

	afterEach(() => {
		disposers.splice(0).forEach((dispose) => dispose());
		document.body.replaceChildren();
		document.body.className = "";
		vi.unstubAllGlobals();
	});

	const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

	function fixture(widths = [50, 50], wrapped = false, rtl = false) {
		const element = document.createElement("div");
		const layout = document.createElement("div");
		layout.className = "layout-columns";
		layout.style.direction = rtl ? "rtl" : "ltr";
		layout.style.gridTemplateColumns = "repeat(2, 1fr)";
		element.append(layout); document.body.append(element);
		const rect = (left: number, width: number, top = 0) => ({ left, right: left + width, top, bottom: top + 100, width, height: 100, x: left, y: top, toJSON() {} });
		const rootWidth = 1000 + (widths.length - 1) * 16;
		element.getBoundingClientRect = () => rect(0, rootWidth);
		widths.forEach((_, index) => {
			const item = document.createElement("div"); item.className = "layout-item"; layout.append(item);
			item.getBoundingClientRect = () => {
				const matches = Array.from(layout.style.gridTemplateColumns.matchAll(/, ([\d.]+)fr\)/g), (match) => Number(match[1]));
				const ratios = matches.length === widths.length ? matches : widths;
				const width = ratios[index]! * 10;
				const before = ratios.slice(0, index).reduce((sum, value) => sum + value * 10, 0) + 16 * index;
				return rect(rtl ? rootWidth - before - width : before, width, wrapped ? 120 * index : 0);
			};
		});
		const prepare = vi.fn(async () => ({ snapshot: "original" }));
		const commit = vi.fn(async (_app: unknown, _prepared: unknown, _ratios: number[], _separator: string) => ({ source: "saved" }));
		const dispose = attachResizers({ app: {}, source: "original", element, layout, context: {}, separator: ":::", child: { register() {} }, prepare, commit });
		disposers.push(dispose);
		const handle = element.querySelector<HTMLElement>('[role="separator"]')!;
		const grip = handle.querySelector<HTMLElement>(".colsdown-resize-grip")!;
		handle.setPointerCapture = vi.fn(); handle.hasPointerCapture = () => false;
		return { element, layout, handle, grip, prepare, commit, dispose };
	}

	function animationSpy(grip: HTMLElement) {
		const animations: Array<{ cancel: ReturnType<typeof vi.fn> }> = [];
		const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => {
			const animation = { cancel: vi.fn() };
			animations.push(animation);
			return animation;
		});
		Object.defineProperty(grip, "animate", { configurable: true, value: animate });
		return { animate, animations };
	}

	function pointer(target: EventTarget, type: string, x: number) {
		const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x });
		Object.defineProperty(event, "pointerId", { value: 1 });
		target.dispatchEvent(event);
	}

	function key(target: EventTarget, type: string, value: string) {
		target.dispatchEvent(new KeyboardEvent(type, { key: value, bubbles: true, cancelable: true }));
	}

	describe("5% boundaries", () => {
		it("snaps cumulative boundaries, preserving non-adjacent columns", () => {
			expect(resizeRatios([25, 50, 25], 0, 28)).toEqual([30, 45, 25]);
			expect(resizeRatios([25, 50, 25], 1, 68)).toEqual([25, 45, 30]);
		});
		it("preserves 100% with thirds and enforces minimum widths", () => {
			const next = resizeRatios([100 / 3, 100 / 3, 100 / 3], 0, 35)!;
			expect(next).toEqual([35, 31.6667, 33.3333]);
			expect(next.reduce((sum, value) => sum + value, 0)).toBe(100);
			expect(resizeRatios([50, 50], 0, 101)).toEqual([95, 5]);
			expect(resizeRatios([50, 50], 0, -3)).toEqual([5, 95]);
			expect(resizeRatios([2, 3, 95], 0, 5)).toBeNull();
		});
	});

	describe("resize gestures", () => {
		it("exposes accessible separator semantics and commits held arrows once", async () => {
			const { handle, commit, prepare } = fixture();
			expect(handle.getAttribute("aria-label")).toBe("Resize columns 1 and 2");
			expect(handle.getAttribute("aria-orientation")).toBe("vertical");
			expect(handle.tabIndex).toBe(0);
			expect(handle.getAttribute("aria-valuemin")).toBe("5");
			expect(handle.getAttribute("aria-valuemax")).toBe("95");
			key(handle, "keydown", "ArrowRight"); key(handle, "keydown", "ArrowRight");
			expect(handle.getAttribute("aria-valuenow")).toBe("60");
			expect(commit).not.toHaveBeenCalled();
			key(handle, "keyup", "ArrowRight"); await settle();
			expect(prepare).toHaveBeenCalledTimes(1);
			expect(commit).toHaveBeenCalledTimes(1);
			expect(commit.mock.calls[0]).toEqual([{}, { snapshot: "original" }, [60, 40], ":::"]);
		});
		it("previews pointer movement and saves only at release", async () => {
			const { handle, commit } = fixture();
			pointer(handle, "pointerdown", 508); pointer(window, "pointermove", 620);
			expect(commit).not.toHaveBeenCalled();
			pointer(window, "pointerup", 620); await settle();
			expect(commit).toHaveBeenCalledTimes(1);
			expect(commit.mock.calls[0]?.[2]).toEqual([60, 40]);
		});
		it("keeps live percentages out of visible status while updating ARIA values", () => {
			const { element, handle } = fixture();
			pointer(handle, "pointerdown", 508); pointer(window, "pointermove", 560);
			expect(element.querySelector('[role="status"]')?.textContent).toBe("");
			expect(handle.getAttribute("aria-valuenow")).toBe("55");
			expect(handle.getAttribute("aria-valuetext")).toBe("55%");
		});
		it("runs one interruptible spring for each changed snapped boundary", () => {
			const { handle, grip } = fixture();
			const motion = animationSpy(grip);
			pointer(handle, "pointerdown", 508);
			pointer(window, "pointermove", 560);
			pointer(window, "pointermove", 570);
			expect(motion.animate).toHaveBeenCalledTimes(1);
			expect(motion.animations[0]?.cancel).not.toHaveBeenCalled();
			pointer(window, "pointermove", 620);
			expect(motion.animate).toHaveBeenCalledTimes(2);
			expect(motion.animations[0]?.cancel).toHaveBeenCalledTimes(1);
			expect(motion.animate.mock.calls[0]?.[0]?.[0]).toMatchObject({
				transform: "translateX(2.5px) scaleX(0.82)",
			});
			expect(motion.animate.mock.calls[0]?.[1]).toMatchObject({ duration: 210 });
		});
		it("reverses tactile motion for RTL keyboard movement", () => {
			const { handle, grip } = fixture([50, 50], false, true);
			const motion = animationSpy(grip);
			key(handle, "keydown", "ArrowLeft");
			expect(motion.animate.mock.calls[0]?.[0]?.[0]).toMatchObject({
				transform: "translateX(-2.5px) scaleX(0.82)",
			});
		});
		it.each(["media", "body class"])("suppresses tactile motion for reduced motion via %s", (source) => {
			if (source === "media") vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
			else document.body.classList.add("reduced-motion");
			const { handle, grip } = fixture();
			const motion = animationSpy(grip);
			pointer(handle, "pointerdown", 508); pointer(window, "pointermove", 560);
			expect(motion.animate).not.toHaveBeenCalled();
		});
		it("cancels tactile motion on origin return and unload", () => {
			const { handle, grip, dispose } = fixture();
			const motion = animationSpy(grip);
			pointer(handle, "pointerdown", 508); pointer(window, "pointermove", 560);
			pointer(window, "pointermove", 508);
			expect(motion.animations[0]?.cancel).toHaveBeenCalledTimes(1);
			pointer(window, "pointermove", 560);
			dispose();
			expect(motion.animations[1]?.cancel).toHaveBeenCalledTimes(1);
			expect(handle.isConnected).toBe(false);
		});
		it.each([29.9995, 30.0005])("advances subpixel-rounded %s%% tracks on the first arrow", async (width) => {
			const { handle, commit } = fixture([width, 100 - width]);
			key(handle, "keydown", "ArrowRight"); key(handle, "keyup", "ArrowRight"); await settle();
			expect(commit.mock.calls[0]?.[2]).toEqual([35, 65]);
		});
		it("does not save when opposing keys restore a subpixel-rounded boundary", async () => {
			const { handle, commit, layout } = fixture([29.9995, 70.0005]);
			key(handle, "keydown", "ArrowRight"); key(handle, "keydown", "ArrowLeft");
			key(handle, "keyup", "ArrowRight"); key(handle, "keyup", "ArrowLeft"); await settle();
			expect(commit).not.toHaveBeenCalled();
			expect(layout.style.gridTemplateColumns).toBe("repeat(2, 1fr)");
		});
		it.each(["escape", "pointercancel", "blur", "unload", "resize"])("cancels %s without saving", async (reason) => {
			const { handle, layout, commit, dispose } = fixture();
			pointer(handle, "pointerdown", 508); pointer(window, "pointermove", 610);
			if (reason === "escape") key(window, "keydown", "Escape");
			else if (reason === "unload") dispose();
			else if (reason === "pointercancel") pointer(window, "pointercancel", 610);
			else window.dispatchEvent(new Event(reason));
			pointer(window, "pointerup", 610); await settle();
			expect(commit).not.toHaveBeenCalled();
			expect(layout.style.gridTemplateColumns).toBe("repeat(2, 1fr)");
		});
		it("does not write for a click or an unchanged snapped step", async () => {
			const { handle, commit } = fixture();
			pointer(handle, "pointerdown", 508); pointer(window, "pointermove", 510); pointer(window, "pointerup", 510);
			await settle(); expect(commit).not.toHaveBeenCalled();
		});
		it("restores tracks and reports failed persistence", async () => {
			const { handle, layout, element, commit } = fixture();
			commit.mockRejectedValueOnce(new Error("The note changed. Reopen it and try again."));
			key(handle, "keydown", "ArrowLeft"); key(handle, "keyup", "ArrowLeft"); await settle();
			expect(layout.style.gridTemplateColumns).toBe("repeat(2, 1fr)");
			expect(element.querySelector('[role="status"]')?.textContent).toContain("Widths were not saved");
		});
		it.each([0, 1])("does not snap thirds for %s px horizontal movement", async (delta) => {
			const { handle, layout, commit } = fixture([100 / 3, 100 / 3, 100 / 3]);
			pointer(handle, "pointerdown", 340); pointer(window, "pointermove", 340 + delta); pointer(window, "pointerup", 340 + delta);
			await settle();
			expect(commit).not.toHaveBeenCalled();
			expect(layout.style.gridTemplateColumns).toBe("repeat(2, 1fr)");
		});
		it("restores unsnapped thirds when a pointer returns to its origin", async () => {
			const { handle, layout, commit } = fixture([100 / 3, 100 / 3, 100 / 3]);
			pointer(handle, "pointerdown", 340); pointer(window, "pointermove", 440); pointer(window, "pointermove", 340); pointer(window, "pointerup", 340);
			await settle();
			expect(commit).not.toHaveBeenCalled();
			expect(layout.style.gridTemplateColumns).toBe("repeat(2, 1fr)");
		});
		it("hides handles for wrapped columns", () => {
			const { handle, commit } = fixture([50, 50], true);
			expect(handle.hidden).toBe(true); key(handle, "keydown", "ArrowRight"); expect(commit).not.toHaveBeenCalled();
		});
		it("moves keyboard boundaries in the visual direction for RTL", async () => {
			const { handle, commit } = fixture([50, 50], false, true);
			key(handle, "keydown", "ArrowLeft"); key(handle, "keyup", "ArrowLeft"); await settle();
			expect(commit.mock.calls[0]?.[2]).toEqual([55, 45]);
		});
	});
});

describe("Add-column controls", () => {
	interface RenderPlugin {
	  app: unknown;
	  settings: { separator: string };
	  activeResizers?: Set<() => void>;
	}

	interface RenderContext {
	  sourcePath: string;
	  addChild: (child: ObsidianMock.MarkdownRenderChild) => void;
	}

	interface ColsdownApi {
	  renderLayout: (plugin: RenderPlugin, source: string, element: HTMLElement, context: RenderContext, direction: string) => Promise<void>;
	}

	let api: ColsdownApi;
	 api = require("../src/main.cjs") as ColsdownApi;

	const children: ObsidianMock.MarkdownRenderChild[] = [];

	afterEach(() => {
	  children.splice(0).reverse().forEach((child) => child.unload());
	  document.body.replaceChildren();
	});

	const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

	async function fixture(source = "First\n::: 70%\nSecond", direction = "row", toolbar = "modern", separator = ":::") {
	  let note = `\`\`\`colsdown\n${source}\n\`\`\``;
	  const file = { path: "Example.md" };
	  const read = vi.fn(async () => note);
	  const process = vi.fn(async (_file: unknown, update: (value: string) => string) => { note = update(note); });
	  const plugin: RenderPlugin = {
	    app: { vault: { getAbstractFileByPath: () => file, read, process }, workspace: { getLeavesOfType: () => [] } },
	    settings: { separator },
	  };
	  const widget = document.createElement("div");
	  widget.className = "cm-embed-block";
	  const element = document.createElement("div");
	  widget.append(element);
	  document.body.append(widget);
	  const actions = document.createElement("div");
	  actions.className = "embed-actions";
	  const edit = document.createElement("button");
	  edit.className = "edit-block-button";
	  if (toolbar === "modern") { actions.append(edit); widget.append(actions); }
	  if (toolbar === "legacy") widget.append(edit);
	  await api.renderLayout(plugin, source, element, { sourcePath: file.path, addChild: (child) => children.push(child) }, direction);
	  const button = widget.querySelector<HTMLButtonElement>(".colsdown-add-column");
	  return { plugin, widget, element, actions, edit, button: button!, read, process, note: () => note };
	}

	describe("add column control", () => {
	  it("places an accessible plus button immediately before the native code button", async () => {
	    const { actions, edit, button, widget } = await fixture();
	    expect(button.parentElement).toBe(actions);
	    expect(button.nextElementSibling).toBe(edit);
	    expect(button.type).toBe("button");
	    expect(button.getAttribute("aria-label")).toBe("Add column");
	    expect(button.querySelector('[data-icon="plus"]')).not.toBeNull();
	    const nativeClick = vi.fn();
	    widget.addEventListener("click", nativeClick);
	    button.click();
	    await settle();
	    expect(nativeClick).not.toHaveBeenCalled();
	  });

	  it("appends an auto column with placeholder text, preserves widths, and supports repeated adds", async () => {
	    const { button, element, note, process } = await fixture();
	    button.click();
	    button.click();
	    await settle();
	    expect(process).toHaveBeenCalledTimes(1);
	    expect(note()).toBe("```colsdown\nFirst\n::: 70%\nSecond\n:::\nNew column\n```");
	    expect(element.querySelectorAll(".layout-item")).toHaveLength(3);
	    expect(element.querySelector(".layout-item:last-child .layout-content p")?.textContent).toBe("New column");
	    expect(element.querySelectorAll('[role="separator"]')).toHaveLength(2);
	    button.click();
	    await settle();
	    expect(process).toHaveBeenCalledTimes(2);
	    expect(element.querySelectorAll(".layout-item")).toHaveLength(4);
	    expect(element.querySelector(".layout-item:last-child .layout-content p")?.textContent).toBe("New column");
	    expect(element.querySelectorAll('[role="separator"]')).toHaveLength(3);
	    expect(element.querySelector(".colsdown-add-status")?.textContent).toBe("Column added.");
	  });

	  it("keeps explicit resized proportions and gives the added column an equal share", async () => {
	    const { button, element, note } = await fixture("::: 30%\nFirst\n::: 70%\nSecond");

	    button.click();
	    await settle();

	    expect(note()).toBe(
	      "```colsdown\n::: 20%\nFirst\n::: 46.6667%\nSecond\n:::\nNew column\n```",
	    );
	    expect(element.querySelectorAll(".layout-item")).toHaveLength(3);
	    expect(element.querySelector<HTMLElement>(".layout-columns")?.style.gridTemplateColumns).toBe(
	      "minmax(0, 20fr) minmax(0, 46.6667fr) minmax(0, 33.33330000000001fr)",
	    );
	  });

	  it("adds to single-column blocks and leaves stacks without a plus button", async () => {
	    const single = await fixture("First");
	    single.button.click();
	    await settle();
	    expect(single.element.querySelectorAll(".layout-item")).toHaveLength(2);
	    expect((await fixture("First\n:::\nSecond", "column")).button).toBeNull();
	  });

	  it("supports native code buttons created after the renderer and legacy toolbars", async () => {
	    const delayed = await fixture("First", "row", "delayed");
	    delayed.actions.append(delayed.edit);
	    delayed.widget.append(delayed.actions);
	    await settle();
	    expect(delayed.button.nextElementSibling).toBe(delayed.edit);
	    const legacy = await fixture("First", "row", "legacy");
	    expect(legacy.button.nextElementSibling).toBe(legacy.edit);
	    expect(legacy.button.classList.contains("colsdown-add-column--legacy")).toBe(true);
	  });

	  it("shows save failures without changing the layout, then allows retry", async () => {
	    const { button, element, process, note } = await fixture();
	    const original = note();
	    process.mockRejectedValueOnce(new Error("Disk full"));
	    button.click();
	    await settle();
	    expect(note()).toBe(original);
	    expect(element.querySelectorAll(".layout-item")).toHaveLength(2);
	    expect(element.querySelector(".colsdown-add-status.is-error")?.textContent).toContain("Disk full");
	    expect(button.disabled).toBe(false);
	    button.click();
	    await settle();
	    expect(element.querySelectorAll(".layout-item")).toHaveLength(3);
	    expect(element.querySelector(".colsdown-add-status.is-error")).toBeNull();
	  });

	  it("keeps the rendered separator when settings change before an add", async () => {
	    const { plugin, button, note, element } = await fixture("First\n|||\nSecond", "row", "modern", "|||");
	    plugin.settings.separator = "###";
	    button.click();
	    await settle();
	    expect(note()).toBe("```colsdown\nFirst\n|||\nSecond\n|||\nNew column\n```");
	    expect(element.querySelectorAll(".layout-item")).toHaveLength(3);
	  });

	  it("reattaches the plus button when Obsidian replaces the native toolbar", async () => {
	    const { actions, button } = await fixture();
	    const replacement = document.createElement("div");
	    replacement.className = "embed-actions";
	    const edit = document.createElement("button");
	    edit.className = "edit-block-button";
	    replacement.append(edit);
	    actions.replaceWith(replacement);
	    await settle();
	    expect(button.parentElement).toBe(replacement);
	    expect(button.nextElementSibling).toBe(edit);
	  });

	  it("removes controls on plugin disable and cancels an uncommitted add", async () => {
	    const { plugin, button, read, process, widget } = await fixture();
	    let finishRead!: (note: string) => void;
	    read.mockImplementationOnce(() => new Promise<string>((resolve) => { finishRead = resolve; }));
	    button.click();
	    plugin.activeResizers?.forEach((dispose) => dispose());
	    finishRead("```colsdown\nFirst\n::: 70%\nSecond\n```");
	    await settle();
	    expect(process).not.toHaveBeenCalled();
	    expect(widget.querySelector(".colsdown-add-column")).toBeNull();
	    expect(widget.querySelector('[role="separator"]')).toBeNull();
	  });
	});
});

describe("Layout footnotes", () => {
	interface FootnoteApi {
		collectFootnoteDefinitions: (source: string) => Map<string, string>;
		hasFootnoteReferences: (markdown: string) => boolean;
		hydrateFootnotes: (markdown: string, definitions: Map<string, string>) => string;
	}

	interface RenderPlugin {
		app: {
			vault: {
				cachedRead: ReturnType<typeof vi.fn>;
				getAbstractFileByPath: ReturnType<typeof vi.fn>;
				modify: ReturnType<typeof vi.fn>;
				process: ReturnType<typeof vi.fn>;
				write: ReturnType<typeof vi.fn>;
			};
			workspace: { getLeavesOfType: ReturnType<typeof vi.fn> };
		};
		settings: { separator: string };
		activeResizers?: Set<() => void>;
		activeFootnoteRenders?: Set<{ sourcePath: string; refresh: () => Promise<void>; dispose: () => void }>;
	}

	interface RenderContext {
		sourcePath: string;
		addChild: (child: ObsidianMock.MarkdownRenderChild) => void;
		getSectionInfo?: (element: HTMLElement) => { lineEnd: number; lineStart: number; text?: string } | null;
	}

	interface ColsdownApi {
		refreshFootnoteLayouts: (plugin: RenderPlugin, file: { path: string }) => Promise<void>;
		parseLayout: (
			source: string,
			direction: "row" | "column",
			separator: string,
		) => { items: Array<{ markdown: string }> };
		renderLayout: (
			plugin: RenderPlugin,
			source: string,
			element: HTMLElement,
			context: RenderContext,
			direction: "row" | "column",
		) => Promise<void>;
	}

	let footnotes: FootnoteApi;

	let api: ColsdownApi;

		footnotes = require("../src/footnotes.cjs") as FootnoteApi;
		api = require("../src/main.cjs") as ColsdownApi;

	const children: ObsidianMock.MarkdownRenderChild[] = [];

	afterEach(() => {
		children.splice(0).reverse().forEach((child) => child.unload());
		document.body.replaceChildren();
	});

	function deferred<T>() {
		let resolve!: (value: T | PromiseLike<T>) => void;
		let reject!: (reason?: unknown) => void;
		const promise = new Promise<T>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		return { promise, reject, resolve };
	}

	const withoutTerminalLineBreak = (value: string) => value.replace(/\r?\n$/, "");

	const originalItems = (source: string, direction: "row" | "column" = "row") => (
		api.parseLayout(source, direction, ":::").items.map((item) => item.markdown)
	);

	const nestedLayoutFences = (depth: number, content: string): string => {
		if (depth === 0) return content;
		const fence = "`".repeat(depth + 2);
		return `${fence}colsdown\n${nestedLayoutFences(depth - 1, content)}\n${fence}`;
	};

	function renderFixture(
		note: string,
		source: string,
		direction: "row" | "column" = "row",
		options: {
			cachedRead?: () => Promise<string>;
			file?: { path: string } | null;
			sectionInfo?: { lineEnd: number; lineStart: number; text?: string } | null;
			sourcePath?: string;
		} = {},
	) {
		const file = { path: "Example.md" };
		const vault = {
			cachedRead: vi.fn(options.cachedRead ?? (async () => note)),
			getAbstractFileByPath: vi.fn(() => options.file === undefined ? file : options.file),
			modify: vi.fn(),
			process: vi.fn(),
			write: vi.fn(),
		};
		const plugin: RenderPlugin = {
			app: { vault, workspace: { getLeavesOfType: vi.fn(() => []) } },
			settings: { separator: ":::" },
		};
		const element = document.createElement("div");
		const context: RenderContext = {
			addChild: (child) => children.push(child),
			getSectionInfo: options.sectionInfo === undefined ? undefined : () => options.sectionInfo ?? null,
			sourcePath: options.sourcePath ?? file.path,
		};
		const result = api.renderLayout(plugin, source, element, context, direction);
		return { context, element, file, plugin, result, vault };
	}

	describe("footnote source semantics", () => {
		it("collects a definition with its complete multiline source text", () => {
			const source = [
				"Before",
				"[^details]: First line with **formatting**",
				"    continuation with [a link](https://example.com)",
				"",
				"    final paragraph",
				"After",
			].join("\n");

			const definitions = footnotes.collectFootnoteDefinitions(source);
			expect(withoutTerminalLineBreak(definitions.get("details") ?? "")).toBe([
					"[^details]: First line with **formatting**",
					"    continuation with [a link](https://example.com)",
					"",
					"    final paragraph",
				].join("\n"));
		});

		it("preserves CRLF bytes in collected definitions", () => {
			const definition = "[^windows]: First\r\n    second\r\n\r\n    third";
			const [collected] = footnotes.collectFootnoteDefinitions(`${definition}\r\nEnd`).values();
			expect(withoutTerminalLineBreak(collected ?? "")).toBe(definition);
		});

		it("matches native case-insensitive labels and last-definition precedence", () => {
			const source = "[^Mixed]: First definition.\n[^mixed]: Last definition.";

			expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map([
				["mixed", "[^mixed]: Last definition."],
			]));
		});

		it("excludes definition-like YAML frontmatter while preserving a real body definition", () => {
			const source = "\uFEFF---\r\nsummary: |\r\n  [^metadata-only]: Not Markdown.\r\n  [^source]: metadata only\r\n---\r\n[^source]: Real body definition.\r\n";
			const original = source;

			expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map([
				["source", "[^source]: Real body definition.\r\n"],
			]));
			expect(source).toBe(original);
		});

		it("preserves native continuation indentation and excludes an invalid paragraph continuation", () => {
			const source = [
				"[^shape]: First line",
				"  immediate two-space continuation",
				"\timmediate tab continuation",
				"",
				"  outside the footnote",
				"[^paragraph]: First paragraph",
				"",
				"    second paragraph",
			].join("\n");

			const definitions = footnotes.collectFootnoteDefinitions(source);
			expect(withoutTerminalLineBreak(definitions.get("shape") ?? "")).toBe([
					"[^shape]: First line",
					"  immediate two-space continuation",
					"\timmediate tab continuation",
				].join("\n"));
			expect(withoutTerminalLineBreak(definitions.get("paragraph") ?? "")).toBe(
				"[^paragraph]: First paragraph\n\n    second paragraph",
			);
		});

		it("ignores definition-like text in non-layout code and comments", () => {
			const source = [
				"```text",
				"[^backtick]: hidden",
				"```",
				"~~~text",
				"[^tilde]: hidden",
				"~~~",
				"    [^indented]: hidden",
				"<!-- [^comment]: hidden -->",
				"\\[^escaped]: hidden",
				"`[^inline]: hidden`",
				"[^visible]: shown",
			].join("\n");

			expect([...footnotes.collectFootnoteDefinitions(source).values()]).toEqual(["[^visible]: shown"]);
		});

		it("ignores definitions and references inside Obsidian percent comments", () => {
			const source = [
				"Before %% [^inline]: hidden %% after",
				"%%",
				"[^block]: hidden",
				"Reference[^also-hidden]",
				"%%",
				"[^visible]: shown",
			].join("\n");

			expect([...footnotes.collectFootnoteDefinitions(source).values()]).toEqual(["[^visible]: shown"]);
			expect(footnotes.hasFootnoteReferences("%% hidden[^inline] %%")).toBe(false);
			expect(footnotes.hasFootnoteReferences("%%\nhidden[^block]\n%%")).toBe(false);
		});

		it("keeps Unicode labels distinct when lowercase normalization does not equate them", () => {
			const definitions = footnotes.collectFootnoteDefinitions(
				"[^ß]: Eszett definition.\n[^SS]: Double-s definition.",
			);

			expect([...definitions.keys()]).toEqual(["ß", "ss"]);
		});

		it("treats capital and lowercase Eszett as one label with last-definition precedence", () => {
			const definitions = footnotes.collectFootnoteDefinitions(
				"[^ß]: First definition.\n[^ẞ]: Last definition.",
			);

			expect(definitions).toEqual(new Map([["ß", "[^ẞ]: Last definition."]]));
		});

		it("uses whole-string lowercasing when a label expands", () => {
			const definitions = footnotes.collectFootnoteDefinitions(
				"[^İ]: First dotted-I definition.\n[^i̇]: Last dotted-I definition.\n[^i]: Plain-I definition.",
			);

			expect([...definitions.keys()]).toEqual(["i̇", "i"]);
			expect(withoutTerminalLineBreak(definitions.get("i̇") ?? "")).toBe(
				"[^i̇]: Last dotted-I definition.",
			);
			expect(definitions.get("i")).toBe("[^i]: Plain-I definition.");
		});

		it("uses whole-string context when lowercasing Greek sigma labels", () => {
			const definitions = footnotes.collectFootnoteDefinitions(
				"[^ΟΣ]: First final-sigma definition.\n[^ος]: Last final-sigma definition.\n[^οσ]: Standard-sigma definition.",
			);

			expect([...definitions.keys()]).toEqual(["ος", "οσ"]);
			expect(withoutTerminalLineBreak(definitions.get("ος") ?? "")).toBe(
				"[^ος]: Last final-sigma definition.",
			);
			expect(definitions.get("οσ")).toBe("[^οσ]: Standard-sigma definition.");
		});

		it("collects definitions inside recognized layout fences while ordinary nested fences stay opaque", () => {
			const source = [
				"````colsdown",
				"Reference[^inside]",
				":::",
				"```text",
				"[^ordinary]: hidden",
				"```",
				"[^inside]: visible",
				"````",
			].join("\n");

			expect(withoutTerminalLineBreak(
				footnotes.collectFootnoteDefinitions(source).get("inside") ?? "",
			)).toBe("[^inside]: visible");
		});

		it("collects only definitions within the supported six-level layout depth", () => {
			const source = [
				nestedLayoutFences(6, "[^supported]: visible"),
				nestedLayoutFences(7, "[^too-deep]: hidden"),
			].join("\n");

			expect([...footnotes.collectFootnoteDefinitions(source).keys()]).toEqual(["supported"]);
		});

		it.each([
			["- Parent\n    - Child[^note]", true],
			["1. Parent\n   continuation[^note]", true],
			["- Parent\n\t- Child[^note]", true],
			["> - Parent\n>     - Child[^note]", true],
			["    code[^note]", false],
			["\tcode[^note]", false],
			["- Parent\n\n        code[^note]", false],
			["- Parent\n\n      code[^note]", false],
			["<!--\n- Fake\n-->\n    code[^note]", false],
			["> ```text\n> literal[^note]\n> ```", false],
			["- Parent\n    ```text\n    literal[^note]\n    ```", false],
		])("detects references in Markdown containers: %s", (markdown, expected) => {
			expect(footnotes.hasFootnoteReferences(markdown)).toBe(expected);
		});

		it("does not treat a top-level fence as the closer of an implicitly ended quoted fence", () => {
			const note = "> ```text\n> literal\n\n```\n[^note]: literal code\n```\n\n[^real]: Actual definition.";
			expect([...footnotes.collectFootnoteDefinitions(note)]).toEqual([["real", "[^real]: Actual definition."]]);
			expect(footnotes.hasFootnoteReferences(note.replace("[^note]: literal code", "literal[^note]"))).toBe(false);
		});

		it.each(["", "> "])("ends unclosed list fences at their container boundary: %s", (quote) => {
			const note = `${quote}- Parent\n${quote}  \`\`\`text\n${quote}  [^literal]: code\n\n[^real]: Actual definition.`;
			expect([...footnotes.collectFootnoteDefinitions(note)]).toEqual([["real", "[^real]: Actual definition."]]);
		});

		it("removes each parent fence indent before collecting nested definitions", () => {
			const note = "   ````colsdown\n   Outer[^shared]\n      ```stack\n      [^shared]: Nested definition.\n      ```\n   ````";
			expect(withoutTerminalLineBreak(footnotes.collectFootnoteDefinitions(note).get("shared") ?? "")).toBe("[^shared]: Nested definition.");
		});

		it("does not carry list indentation out of an implicitly ended quote", () => {
			const prefix = "> - Parent\n>   ```text\n>   literal\n";
			expect(footnotes.hasFootnoteReferences(prefix + "    code[^bad]")).toBe(false);
			expect(footnotes.collectFootnoteDefinitions(prefix + "    [^bad]: code").size).toBe(0);
		});

		it.each(["2.", "12)"])("does not let ordered marker %s interrupt an existing paragraph", (marker) => {
			expect(footnotes.hasFootnoteReferences(`Paragraph\n${marker} \`\`\`text\n   Visible[^x]`)).toBe(true);
		});

		it("lets ordered lists starting at one interrupt a paragraph, with an opaque fence", () => {
			expect(footnotes.hasFootnoteReferences("Paragraph\n1. ```text\n   Literal[^x]")).toBe(false);
		});

		it.each(["$$\n[^math]: formula annotation\n$$", "> $$\n> [^math]: formula annotation\n> $$", "- Formula\n  $$\n  [^math]: formula annotation\n  $$"])("keeps display math opaque: %s", (math) => {
			expect(footnotes.collectFootnoteDefinitions(math).size).toBe(0);
			expect(footnotes.hasFootnoteReferences(math.replace("[^math]:", "literal[^math]"))).toBe(false);
			expect(footnotes.collectFootnoteDefinitions(math + "\n\n[^real]: Real definition.").get("real")).toBe("[^real]: Real definition.");
		});

		it.each(["Name | Value\n--- | ---\nOne | Two", "| Name | Value |\n| :--- | ---: |\n| One | Two |"])("keeps HTML after a table opaque: %s", (table) => {
			const source = table + "\n<widget>\nHidden[^bad].\n[^bad]: Raw HTML.\n</widget>\n\n[^real]: Actual definition.";
			expect(footnotes.collectFootnoteDefinitions(source).has("bad")).toBe(false);
			expect(footnotes.hasFootnoteReferences(source)).toBe(false);
		});

		it.each(["> Text <!--\n\n", "- Text <!--\n\n", "Text <!--\n\n"])("does not mask a new block after an unclosed inline comment: %s", async (prefix) => {
			const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
			const source = "Visible[^external]";
			const note = prefix + "```colsdown\n" + source + "\n```\n\n[^external]: Outside definition.";
			const fixture = renderFixture(note, source);
			await fixture.result;
			expect(render.mock.calls[0]?.[1]).toContain("[^external]: Outside definition.");
		});

		it("keeps an unterminated inline HTML opener literal within its paragraph", () => {
			expect(footnotes.hasFootnoteReferences("Text <!-- visible[^note].")).toBe(true);
			expect(footnotes.hasFootnoteReferences("--> Text <!-- visible[^note].")).toBe(true);
			expect(footnotes.hasFootnoteReferences("Text <!--\nHidden[^note].\n--> end")).toBe(false);
		});

		it.each(["---", "===", "***", "___", "* * *", "- - -"])("ends inline HTML comment lookahead at %s", (boundary) => {
			expect(footnotes.hasFootnoteReferences(`Text <!--\n${boundary}\nVisible[^note]\n-->`)).toBe(true);
		});

		it.each(["", "> ", "  "])("excludes definition-like table cells in container %s", (prefix) => {
			const table = ["Name | Value", "--- | ---", "[^fake]: literal cell | Other"].map(line => prefix + line).join("\n");
			const source = (prefix === "  " ? "- Table\n" : "") + table + "\n\n[^real]: Actual definition.";
			expect([...footnotes.collectFootnoteDefinitions(source)]).toEqual([["real", "[^real]: Actual definition."]]);
		});

		it("preserves a real definition when its label also starts a table cell", () => {
			const source = "Name | Value\n--- | ---\n[^same]: literal cell | Other\n\n[^same]: Actual definition.";
			expect(footnotes.collectFootnoteDefinitions(source).get("same")).toBe("[^same]: Actual definition.");
		});

		it.each(["", "> "])("preserves valid four-space quoted definition content with outer prefix %s", (prefix) => {
			const source = ["[^note]: First", "    > quoted continuation"].map(line => prefix + line).join("\n");
			expect(footnotes.collectFootnoteDefinitions(source).get("note")).toBe("[^note]: First\n    > quoted continuation");
		});

		it("keeps a two-space blockquote separate from the preceding definition", () => {
			expect(footnotes.collectFootnoteDefinitions("[^note]: First\n  > separate quote\n").get("note")).toBe("[^note]: First\n");
		});

		it("collects quoted definitions without changing their remaining Markdown or line endings", () => {
			const source = "> [^note]: First\r\n>     - child\r\n>\r\n>         code\r\n";
			expect(footnotes.collectFootnoteDefinitions(source).get("note")).toBe("[^note]: First\r\n    - child\r\n\r\n        code\r\n");
		});

		it("detects prose references but excludes definitions, inline notes, escapes, code, and comments", () => {
			expect(footnotes.hasFootnoteReferences("Named[^name] and numeric[^1]")).toBe(true);
			expect(footnotes.hasFootnoteReferences("\\![^after-literal-exclamation]")).toBe(true);
			expect(footnotes.hasFootnoteReferences("![^image-alt]")).toBe(false);
			expect(footnotes.hasFootnoteReferences("[^name]: definition only")).toBe(false);
			expect(footnotes.hasFootnoteReferences("Inline ^[note] only")).toBe(false);
			expect(footnotes.hasFootnoteReferences("\\[^escaped] and `code[^literal]`")).toBe(false);
			expect(footnotes.hasFootnoteReferences("<!-- hidden[^comment] -->")).toBe(false);
			expect(footnotes.hasFootnoteReferences("```text\nhidden[^fence]\n```\n    hidden[^indent]")).toBe(false);
		});
	});

	describe("footnote hydration", () => {
		it("appends missing definitions after a blank line without changing the item body", () => {
			const definitions = new Map([
				["external", "[^external]: Outside the layout."],
				["unused", "[^unused]: Native Markdown omits unused definitions."],
			]);
			const hydrated = footnotes.hydrateFootnotes("Body[^external]", definitions);

			expect(hydrated.startsWith("Body[^external]\n\n")).toBe(true);
			expect(hydrated).toContain("[^external]: Outside the layout.");
			expect(hydrated).toContain("[^unused]: Native Markdown omits unused definitions.");
		});

		it("keeps an item-local definition authoritative and does not duplicate it", () => {
			const item = "Body[^same]\n\n[^Same]: Local content.";
			const definitions = new Map([["same", "[^same]: External content."]]);

			expect(footnotes.hydrateFootnotes(item, definitions)).toBe(item);
		});

		it("hydrates repeated references with one shared definition", () => {
			const hydrated = footnotes.hydrateFootnotes(
				"First[^shared] and second[^shared].",
				new Map([["shared", "[^shared]: Shared content."]]),
			);

			expect(hydrated.match(/\[\^shared\]:/giu)).toHaveLength(1);
		});

		it("appends a nested-layout definition outside its fence for an outer reference", () => {
			const markdown = [
				"Outer reference[^shared]",
				"",
				"```stack",
				"[^shared]: Definition inside the nested stack.",
				"```",
			].join("\n");
			const definitions = footnotes.collectFootnoteDefinitions(markdown);

			const hydrated = footnotes.hydrateFootnotes(markdown, definitions);

			expect(hydrated.match(/\[\^shared\]:/giu)).toHaveLength(2);
			expect(hydrated.lastIndexOf("[^shared]:")).toBeGreaterThan(markdown.lastIndexOf("```"));
		});

		it("returns the original bytes when no definitions are available", () => {
			for (const markdown of ["Plain body", "Inline ^[note]", "`literal[^external]`"]) {
				expect(footnotes.hydrateFootnotes(markdown, new Map())).toBe(markdown);
			}
		});
	});

	describe("layout footnote enrichment", () => {
		it("hydrates external and cross-column definitions into transient renderer input", async () => {
			const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
			const source = "External[^outside] and shared[^shared]\n:::\n[^shared]: Cross-column definition.";
			const note = `\`\`\`colsdown\n${source}\n\`\`\`\n\n[^outside]: Definition below the layout.`;
			const fixture = renderFixture(note, source);

			await fixture.result;

			expect(render).toHaveBeenCalledTimes(2);
			expect(render.mock.calls[0]?.[1]).toContain("[^outside]: Definition below the layout.");
			expect(render.mock.calls[0]?.[1]).toContain("[^shared]: Cross-column definition.");
		const secondItem = render.mock.calls[1]?.[1] ?? "";
			expect(secondItem.startsWith("[^shared]: Cross-column definition.")).toBe(true);
			expect(secondItem.match(/\[\^shared\]:/giu)).toHaveLength(1);
			expect(fixture.vault.cachedRead).toHaveBeenCalledTimes(1);
			expect(fixture.vault.modify).not.toHaveBeenCalled();
			expect(fixture.vault.process).not.toHaveBeenCalled();
			expect(fixture.vault.write).not.toHaveBeenCalled();
		});

		it("uses one note read for any number of items", async () => {
			const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
			const source = "One[^shared]\n:::\nTwo[^shared]\n:::\nThree[^shared]";
			const fixture = renderFixture(`\`\`\`colsdown\n${source}\n\`\`\`\n[^shared]: Shared.`, source);

			await fixture.result;

			expect(render).toHaveBeenCalledTimes(3);
			expect(fixture.vault.cachedRead).toHaveBeenCalledTimes(1);
		});

		it("skips note reads for layouts without named references", async () => {
			const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
			const source = "Plain\n:::\nInline ^[note]\n:::\n%% hidden[^external] %%";
			const fixture = renderFixture(`\`\`\`colsdown\n${source}\n\`\`\``, source);

			await fixture.result;

			expect(fixture.vault.cachedRead).not.toHaveBeenCalled();
			expect(render.mock.calls.map((call) => call[1])).toEqual(originalItems(source));
		});

		it.each([
			["missing source path", { sourcePath: "" }],
			["missing source file", { file: null }],
		] as const)("renders original items when the %s prevents enrichment", async (_name, options) => {
			const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
			const source = "Body[^external]\n:::\nSecond";
			const fixture = renderFixture("[^external]: Wrong snapshot.", source, "row", options);

			await fixture.result;

			expect(render.mock.calls.map((call) => call[1])).toEqual(originalItems(source));
		});

		it("renders original items when the note read fails", async () => {
			const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
			const source = "Body[^external]\n:::\nSecond";
			const fixture = renderFixture("unused", source, "row", {
				cachedRead: async () => { throw new Error("Unavailable"); },
			});

			await fixture.result;

			expect(render.mock.calls.map((call) => call[1])).toEqual(originalItems(source));
		});

		it("does not enrich from a snapshot that cannot be matched to the rendered layout", async () => {
			const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
			const source = "Current body[^external]\n:::\nSecond";
			const fixture = renderFixture("Old body[^external]\n\n[^external]: Stale definition.", source);

			await fixture.result;

			expect(render.mock.calls.map((call) => call[1])).toEqual(originalItems(source));
		});

		it("does not enrich when the rendered layout has ambiguous matches in the snapshot", async () => {
			const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
			const source = "Repeated[^external]\n:::\nSecond";
			const block = `\`\`\`colsdown\n${source}\n\`\`\``;
			const fixture = renderFixture(`${block}\n\n${block}\n\n[^external]: Ambiguous.`, source);

			await fixture.result;

			expect(render.mock.calls.map((call) => call[1])).toEqual(originalItems(source));
		});

		it("does not enrich when section coordinates disagree with the matched layout", async () => {
			const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
			const source = "Section[^external]";
			const note = `\`\`\`colsdown\n${source}\n\`\`\`\n\n[^external]: Wrong section.`;
			const fixture = renderFixture(note, source, "row", {
				sectionInfo: { lineEnd: 1000, lineStart: 999, text: note },
			});

			await fixture.result;

			expect(render.mock.calls.map((call) => call[1])).toEqual(originalItems(source));
		});

		it.each(["    ", "\t"])("hydrates a layout nested in a footnote definition with indent %s", async (indent) => {
			vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element) => { element.textContent = markdown; });
			const source = "Inside[^external].";
			const note = ["[^host]:", indent + "```colsdown", indent + source, indent + "```", "", "[^external]: OLD definition."].join("\n");
			const fixture = renderFixture(note, source, "row", { sectionInfo: { text: note, lineStart: 0, lineEnd: 3 } });
			await fixture.result;
			expect(fixture.element.textContent).toContain("OLD definition.");
			expect(footnotes.collectFootnoteDefinitions(note).get("host")).toBe(note.split("\n").slice(0, 4).join("\n") + "\n");
			fixture.vault.cachedRead.mockResolvedValue(note.replace("OLD definition.", "NEW definition."));
			await api.refreshFootnoteLayouts(fixture.plugin, fixture.file);
			expect(fixture.element.textContent).toContain("NEW definition.");
		});

		it.each(["colsdown", "stack"].flatMap((language) => [false, true].map((synthetic) => ({ language, synthetic }))))("hydrates and refreshes a $language first-line fence (synthetic footer: $synthetic)", async ({ language, synthetic }) => {
			vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element) => { element.textContent = markdown; });
			const source = "Inside[^external].";
			const note = ["Outside[^host].", "", `[^host]: \`\`\`${language}`, "    " + source, "    ```", "", "[^external]: OLD definition."].join("\n");
			const fixture = renderFixture(note, source, language === "stack" ? "column" : "row", { sectionInfo: { text: note, lineStart: synthetic ? 7 : 2, lineEnd: synthetic ? 7 : 4 } });
			await fixture.result;
			expect(fixture.element.textContent).toContain("OLD definition.");
			fixture.vault.cachedRead.mockResolvedValue(note.replace("OLD", "NEW"));
			await api.refreshFootnoteLayouts(fixture.plugin, fixture.file);
			expect(fixture.element.textContent).toContain("NEW definition.");
			expect(fixture.vault.modify).not.toHaveBeenCalled();
			expect(fixture.vault.process).not.toHaveBeenCalled();
			expect(fixture.vault.write).not.toHaveBeenCalled();
		});

		it.each(["", " ", "   ", "    ", "       ", "\t"])("hydrates a first-line fence with native post-colon padding %j", async (padding) => {
			const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
			const source = "Inside[^external].";
			const note = `[^host]:${padding}\`\`\`colsdown\n    ${source}\n    \`\`\`\n\n[^external]: External definition.`;
			const fixture = renderFixture(note, source, "row", { sectionInfo: { text: note, lineStart: 0, lineEnd: 2 } });
			await fixture.result;
			expect(render.mock.calls[0]?.[1]).toContain("[^external]: External definition.");
		});

		it("does not classify an eight-space first-line opener as a layout", async () => {
			const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
			const source = "Inside[^external].";
			const note = `[^host]:        \`\`\`colsdown\n    ${source}\n    \`\`\`\n\n[^external]: External definition.`;
			const fixture = renderFixture(note, source, "row", { sectionInfo: { text: note, lineStart: 0, lineEnd: 2 } });
			await fixture.result;
			expect(render.mock.calls.map((call) => call[1])).toEqual(originalItems(source));
		});

		it("collects cross-column definitions from a fence on the definition line", () => {
			const note = "[^host]: ```colsdown\n    Use[^shared]\n    :::\n    [^shared]: Nested definition.\n    ```\n";
			const definitions = footnotes.collectFootnoteDefinitions(note);
			expect(definitions.get("host")).toBe(note);
			expect(definitions.get("shared")).toBe("[^shared]: Nested definition.\n");
		});

		it.each(["    ", "\t"])("collects shared definitions inside a definition-contained layout with indent %s", async (indent) => {
			const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
			const source = "Use[^shared]\n:::\n[^shared]: Nested definition.";
			const host = ["[^host]:", "```colsdown", ...source.split("\n"), "```"].map((line, index) => index === 0 ? line : indent + line).join("\n");
			const note = host + "\n\n[^outside]: External definition.";
			const defs = footnotes.collectFootnoteDefinitions(note);
			expect(defs.get("host")).toBe(host + "\n");
			expect(defs.get("shared")).toBe("[^shared]: Nested definition.\n");
			const fixture = renderFixture(note, source, "row", { sectionInfo: { text: note, lineStart: 0, lineEnd: 5 } });
			await fixture.result;
			expect(render.mock.calls[0]?.[1]).toContain("[^shared]: Nested definition.");
		});

		it.each(["```text", "~~~text", "<!--", "%%"])("keeps a first-line %s opener opaque when collecting definitions", (opener) => {
			const closer = opener.startsWith("`") ? "```" : opener.startsWith("~") ? "~~~" : opener === "<!--" ? "-->" : "%%";
			const note = `[^host]: ${opener}\n    [^fake]: Literal content.\n    ${closer}\n\n[^visible]: Outside definition.`;
			const definitions = footnotes.collectFootnoteDefinitions(note);
			expect(definitions.has("fake")).toBe(false);
			expect(definitions.get("visible")).toBe("[^visible]: Outside definition.");
		});

		it("collects a native nested definition directly from footnote content", () => {
			const source = "[^host]:\n    [^nested]: text\n";
			expect(footnotes.collectFootnoteDefinitions(source).get("nested")).toBe("[^nested]: text\n");
			expect(footnotes.collectFootnoteDefinitions(source).get("host")).toBe(source);
		});

		it("collects native same-line nested definitions and preserves later precedence", () => {
			const source = "Outside[^host] and nested[^nested].\n\n[^host]: [^nested]: text";
			const definitions = footnotes.collectFootnoteDefinitions(source);
			expect(definitions.get("host")).toBe("[^host]: [^nested]: text");
			expect(definitions.get("nested")).toBe(" [^nested]: text");
			expect(footnotes.collectFootnoteDefinitions(source + "\n\n[^nested]: External nested.").get("nested")).toBe("[^nested]: External nested.");
		});

		it("keeps ordinary code in definition bodies opaque and later definition precedence intact", () => {
			const source = "[^host]:\n    ```text\n    [^fake]: Literal code.\n    ```\n\n[^layout]:\n    ```stack\n    [^shared]: Nested definition.\n    ```\n\n[^shared]: Later definition.";
			const defs = footnotes.collectFootnoteDefinitions(source);
			expect(defs.has("fake")).toBe(false);
			expect(defs.get("shared")).toBe("[^shared]: Later definition.");
		});

		it("maps native synthetic footnote-footer coordinates to a unique definition-contained fence", async () => {
			vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element) => { element.textContent = markdown; });
			const source = "Inside[^external].";
			const note = "Outside[^host].\n\n[^host]:\n    ```colsdown\n    " + source + "\n    ```\n\n[^external]: OLD definition.\n";
			const fixture = renderFixture(note, source, "row", { sectionInfo: { text: note, lineStart: 8, lineEnd: 8 } });
			await fixture.result;
			expect(fixture.element.textContent).toContain("OLD definition.");
			fixture.vault.cachedRead.mockResolvedValue(note.replace("OLD", "NEW"));
			await api.refreshFootnoteLayouts(fixture.plugin, fixture.file);
			expect(fixture.element.textContent).toContain("NEW definition.");
			fixture.vault.cachedRead.mockResolvedValue("Inserted\n" + note.replace("OLD", "WRONG"));
			await api.refreshFootnoteLayouts(fixture.plugin, fixture.file);
			expect(fixture.element.textContent).not.toContain("WRONG");
		});

		it("rejects synthetic footer coordinates for ordinary or ambiguous fences", async () => {
			const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
			const source = "Inside[^external].";
			for (const note of ["```colsdown\n" + source + "\n```\n\n[^external]: Wrong.\n", "[^one]:\n    ```colsdown\n    " + source + "\n    ```\n\n[^two]:\n    ```colsdown\n    " + source + "\n    ```\n\n[^external]: Wrong.\n"]) {
				render.mockClear();
				const eof = note.split("\n").length - 1;
				const fixture = renderFixture(note, source, "row", { sectionInfo: { text: note, lineStart: eof, lineEnd: eof } });
				await fixture.result;
				expect(render.mock.calls[0]?.[1]).not.toContain("[^external]: Wrong.");
			}
		});

		it("hydrates a stack inside a quoted footnote definition and preserves CRLF", async () => {
			vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element) => { element.textContent = markdown; });
			const source = "Inside[^external].";
			const note = "> [^host]:\r\n>     ```stack\r\n>     " + source + "\r\n>     ```\r\n\r\n[^external]: Outside definition.";
			const fixture = renderFixture(note, source, "column", { sectionInfo: { text: note, lineStart: 0, lineEnd: 3 } });
			await fixture.result;
			expect(fixture.element.textContent).toContain("Outside definition.");
			expect(footnotes.collectFootnoteDefinitions(note).get("host")).toContain("    ```stack\r\n");
		});

		it.each(["- ", "1. ", "12) ", "- - ", "> - ", "-\t", "1.\t"])("hydrates a fence opening on a list-marker line: %s", async (marker) => {
			const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
			const source = "Marker[^external]\n:::\n[^shared]: Cross-column definition.\nShared[^shared]";
			const prefix = marker.startsWith("> ") ? ">   " : " ".repeat(marker.includes("\t") ? 4 : marker.length);
			const note = "[^before]: A preceding definition.\n\n" + marker + "```colsdown\n" + [...source.split("\n"), "```"].map((line) => prefix + line).join("\n") + "\n\n[^external]: Outside definition.";
			const fixture = renderFixture(note, source, "row", { sectionInfo: { text: note, lineStart: 2, lineEnd: source.split("\n").length + 3 } });
			await fixture.result;
			expect(render.mock.calls[0]?.[1]).toContain("[^external]: Outside definition.");
			expect(render.mock.calls[0]?.[1]).toContain("[^shared]: Cross-column definition.");
		});

		it("keeps sibling list items separate when the first fence ends implicitly", async () => {
			const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
			const source = "First[^external]";
			const note = "- ```colsdown\n  First[^external]\n- ```colsdown\n  Second[^external]\n  ```\n\n[^external]: Outside sibling definition.";
			const fixture = renderFixture(note, source, "row", { sectionInfo: { text: note, lineStart: 0, lineEnd: 4 } });
			await fixture.result;
			expect(render.mock.calls[0]?.[1]).toContain("[^external]: Outside sibling definition.");
		});

		it.each(["quote", "callout", "list", "nested list", "quoted list", "stack"])("hydrates a layout inside a %s and refreshes its exact fence", async (kind) => {
			vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element) => { element.textContent = markdown; });
			const source = "Contained[^external]\n::: \nOther";
			const prefix = kind === "quote" || kind === "callout" ? "> " : kind === "quoted list" ? ">     " : kind === "nested list" ? "      " : "    ";
			const heading = kind === "callout" ? "> [!note]\n" : kind === "quote" ? "> Container\n" : kind === "quoted list" ? "> - Parent\n" : kind === "nested list" ? "- Parent\n  - Child\n" : "- Parent\n";
			const block = [kind === "stack" ? "```stack" : "```colsdown", ...source.split("\n"), "```"].map((line) => prefix + line).join("\n");
			const note = (heading + block + "\n\n[^external]: OLD container definition.").replace(/\n/g, "\r\n");
			const fixture = renderFixture(note, source, kind === "stack" ? "column" : "row", {
				sectionInfo: { text: note, lineStart: 0, lineEnd: heading.split("\n").length - 1 + source.split("\n").length + 1 },
			});
			document.body.appendChild(fixture.element);
			await fixture.result;
			expect(fixture.element.textContent).toContain("OLD container definition.");
			fixture.vault.cachedRead.mockResolvedValue(note.replace("OLD", "NEW"));
			await api.refreshFootnoteLayouts(fixture.plugin, fixture.file);
			expect(fixture.element.textContent).toContain("NEW container definition.");
			fixture.vault.cachedRead.mockResolvedValue("Inserted\r\n" + note.replace("OLD", "WRONG"));
			await api.refreshFootnoteLayouts(fixture.plugin, fixture.file);
			expect(fixture.element.textContent).not.toContain("WRONG");
			expect(fixture.vault.modify).not.toHaveBeenCalled();
		});

		it("rejects an ambiguous enclosing container and a closer outside its container", async () => {
			vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element) => { element.textContent = markdown; });
			const source = "Contained[^external]";
			for (const block of ["Heading\n```colsdown\n" + source + "\n```", "> ```colsdown\n> " + source + "\n> ```\n> ```colsdown\n> " + source + "\n> ```", "> ```colsdown\n> " + source + "\n```"] ) {
				const note = block + "\n\n[^external]: WRONG container definition.";
				const fixture = renderFixture(note, source, "row", { sectionInfo: { text: note, lineStart: 0, lineEnd: block.split("\n").length - 1 } });
				await fixture.result;
				expect(fixture.element.textContent).not.toContain("WRONG");
			}
		});

		it("maps unique heading-embed section coordinates into the full note", async () => {
			const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
			const source = "Embedded[^external]";
			const section = `### Target\n\n\`\`\`colsdown\n${source}\n\`\`\``;
			const note = `# Before\n\n${section}\n\n[^external]: Available outside the embed.`;
			const fixture = renderFixture(note, source, "row", {
				sectionInfo: { lineStart: 2, lineEnd: 4, text: section },
			});

			await fixture.result;

			expect(render.mock.calls[0]?.[1]).toContain("[^external]: Available outside the embed.");
		});

		it.each(["ambiguous", "stale", "wrong coordinates", "mid-line", "mid-line end", "negative", "out of range", "missing text"] as const)(
			"rejects %s heading-embed source context",
			async (kind) => {
				const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
				const source = "Embedded[^external]";
				const section = `### Target\n\n\`\`\`colsdown\n${source}\n\`\`\``;
				const suffix = kind === "mid-line end" ? " suffix" : "";
				const prefix = kind === "mid-line" ? "Prefix " : "# Before\n\n";
				const note = `${prefix}${section}${suffix}\n\n${kind === "ambiguous" ? section + "\n\n" : ""}[^external]: Must not attach.`;
				const fixture = renderFixture(note, source, "row", {
					sectionInfo: {
						lineStart: kind === "negative" ? -1 : kind === "wrong coordinates" ? 1 : 2,
						lineEnd: kind === "out of range" ? 99 : kind === "wrong coordinates" ? 3 : 4,
						text: kind === "missing text" ? undefined : kind === "stale" ? section.replace("Target", "Old target") : section,
					},
				});

				await fixture.result;

				expect(render.mock.calls.map((call) => call[1])).toEqual(originalItems(source));
			},
		);

		it.each(["full note", "CRLF partial"] as const)("matches %s section provenance", async (kind) => {
			const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
			const source = "Embedded[^external]";
			const section = `### Target\n\n\`\`\`colsdown\n${source}\n\`\`\``.replace(/\n/g, "\r\n");
			const note = `# Before\r\n\r\n${section}\r\n\r\n[^external]: Available.`;
			const fixture = renderFixture(note, source, "row", {
				sectionInfo: kind === "full note"
					? { lineStart: 4, lineEnd: 6, text: note }
					: { lineStart: 2, lineEnd: 4, text: section },
			});

			await fixture.result;

			expect(render.mock.calls[0]?.[1]).toContain("[^external]: Available.");
		});

		it("supports detached containers because lifecycle ownership does not depend on isConnected", async () => {
			const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
			const source = "Detached[^external]";
			const fixture = renderFixture(`\`\`\`stack\n${source}\n\`\`\`\n[^external]: Available.`, source, "column");

			expect(fixture.element.isConnected).toBe(false);
			await fixture.result;

			expect(render).toHaveBeenCalledOnce();
			expect(render.mock.calls[0]?.[1]).toContain("[^external]: Available.");
		});

		it("abandons a late note read after its render owner unloads", async () => {
			const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render");
			const pendingRead = deferred<string>();
			const source = "Late[^external]";
			const fixture = renderFixture(
				`\`\`\`colsdown\n${source}\n\`\`\`\n[^external]: Late.`,
				source,
				"row",
				{ cachedRead: () => pendingRead.promise },
			);

			expect(children.length).toBeGreaterThan(0);
			children[0]?.unload();
			pendingRead.resolve(`\`\`\`colsdown\n${source}\n\`\`\`\n[^external]: Late.`);
			await fixture.result;

			expect(render).not.toHaveBeenCalled();
		});

		it("stops rendering remaining items when unloaded during an item render", async () => {
			const pendingRender = deferred<void>();
			const render = vi.spyOn(ObsidianMock.MarkdownRenderer, "render")
				.mockReturnValueOnce(pendingRender.promise);
			const source = "First[^external]\n:::\nSecond[^external]";
			const fixture = renderFixture(`\`\`\`colsdown\n${source}\n\`\`\`\n[^external]: Shared.`, source);
			await Promise.resolve();
			await Promise.resolve();

			expect(render).toHaveBeenCalledOnce();
			children[0]?.unload();
			pendingRender.resolve();
			await fixture.result;

			expect(render).toHaveBeenCalledOnce();
		});

		it("shows only original item Markdown when rendering hydrated input fails", async () => {
			vi.spyOn(console, "error").mockImplementation(() => undefined);
			vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockRejectedValue(new Error("Render failed"));
			const source = "Original[^external]";
			const fixture = renderFixture(`\`\`\`colsdown\n${source}\n\`\`\`\n[^external]: Appended.`, source);

			await fixture.result;

			expect(fixture.element.querySelector(".layout-render-fallback")?.textContent).toBe(source);
			expect(fixture.element.textContent).not.toContain("Appended.");
		});

		it("retries every fallback item after an initial staged render fails", async () => {
			const source = "Referenced[^external]\n:::\nPlain";
			const note = (definition: string) => `\`\`\`colsdown\n${source}\n\`\`\`\n\n[^external]: ${definition}`;
			const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
			let initial = true;
			vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element) => {
				if (initial && markdown === "Plain") {
					initial = false;
					throw new Error("initial plain item failed");
				}
				if (markdown.includes("BROKEN definition.")) throw new Error("later referenced item failed");
				element.textContent = markdown;
			});
			const fixture = renderFixture(note("INITIAL definition."), source);

			try {
				await fixture.result;
				expect(fixture.element.querySelectorAll(".layout-render-fallback")).toHaveLength(2);

				fixture.vault.cachedRead.mockResolvedValue(note("RECOVERED definition."));
				await api.refreshFootnoteLayouts(fixture.plugin, { path: "Example.md" });
				expect(fixture.element.querySelectorAll(".layout-render-fallback")).toHaveLength(0);
				expect(fixture.element.textContent).toContain("RECOVERED definition.");
				expect(fixture.element.textContent).toContain("Plain");

				fixture.vault.cachedRead.mockResolvedValue(note("BROKEN definition."));
				await api.refreshFootnoteLayouts(fixture.plugin, { path: "Example.md" });
				expect(fixture.element.textContent).toContain("RECOVERED definition.");
				expect(fixture.element.textContent).not.toContain("BROKEN definition.");
				expect(fixture.element.textContent).toContain("Plain");
			} finally { log.mockRestore(); }
		});

		it("retries every fallback item after a queued refresh fails during initialization", async () => {
			const source = "Referenced[^external]\n:::\nPlain";
			const note = (definition: string) => `\`\`\`colsdown\n${source}\n\`\`\`\n\n[^external]: ${definition}`;
			const initialRead = deferred<string>();
			const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
			let failQueuedRefresh = true;
			vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element) => {
				if (failQueuedRefresh && markdown === "Plain") {
					failQueuedRefresh = false;
					throw new Error("queued plain item failed");
				}
				element.textContent = markdown;
			});
			const fixture = renderFixture(note("INITIAL definition."), source, "row", {
				cachedRead: () => initialRead.promise,
			});

			try {
				await vi.waitFor(() => expect(fixture.plugin.activeFootnoteRenders?.size).toBe(1));
				fixture.vault.cachedRead.mockResolvedValue(note("QUEUED definition."));
				const refresh = api.refreshFootnoteLayouts(fixture.plugin, { path: "Example.md" });
				initialRead.resolve(note("INITIAL definition."));
				await Promise.all([fixture.result, refresh]);
				expect(fixture.element.querySelectorAll(".layout-render-fallback")).toHaveLength(2);

				fixture.vault.cachedRead.mockResolvedValue(note("RECOVERED definition."));
				await api.refreshFootnoteLayouts(fixture.plugin, { path: "Example.md" });
				expect(fixture.element.querySelectorAll(".layout-render-fallback")).toHaveLength(0);
				expect(fixture.element.textContent).toContain("RECOVERED definition.");
				expect(fixture.element.textContent).toContain("Plain");
			} finally { log.mockRestore(); }
		});
	});

	describe("footnote refresh after source controls", () => {
		const resize = (element: HTMLElement) => {
			const rect = (left: number, width: number) => ({ left, right: left + width, top: 0, bottom: 100, width, height: 100, x: left, y: 0, toJSON() {} });
			element.getBoundingClientRect = () => rect(0, 1016);
			element.querySelectorAll<HTMLElement>(".layout-item").forEach((item, index) => { item.getBoundingClientRect = () => rect(index * 516, 500); });
			const handle = element.querySelector<HTMLElement>('[role="separator"]')!;
			handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
			handle.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }));
		};

		it.each(["resize", "add"])("refreshes definitions after a successful %s without recreating the owner", async (edit) => {
			vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element) => { element.textContent = markdown; });
			const source = "First[^external]\n:::\nSecond";
			const laterSource = "Later[^external]\n:::\nFinal";
			let note = "```colsdown\n" + source + "\n```\n\n```colsdown\n" + laterSource + "\n```\n\n[^external]: OLD definition.";
			const fixture = renderFixture(note, source, "row", { cachedRead: async () => note, sectionInfo: { text: note, lineStart: 0, lineEnd: 4 } });
			Object.assign(fixture.vault, { read: vi.fn(async () => note) });
			fixture.vault.process.mockImplementation(async (_file: unknown, update: (text: string) => string) => { note = update(note); });
			document.body.append(fixture.element);
			await fixture.result;
			const laterElement = document.createElement("div");
			document.body.append(laterElement);
			await api.renderLayout(fixture.plugin, laterSource, laterElement, { sourcePath: fixture.file.path, getSectionInfo: () => ({ text: note, lineStart: 6, lineEnd: 10 }), addChild: (child) => { children.push(child); } }, "row");
			const owners = [...fixture.plugin.activeFootnoteRenders ?? []];
			expect(owners).toHaveLength(2);
			if (edit === "add") fixture.element.querySelector<HTMLButtonElement>(".colsdown-add-column")!.click();
			else resize(fixture.element);
			await vi.waitFor(() => expect(fixture.vault.process).toHaveBeenCalledTimes(1));
			await vi.waitFor(() => expect(fixture.element.textContent).toContain(edit === "add" ? "Column added." : "Widths saved."));
			note = note.replace("OLD definition.", "NEW definition.");
			await api.refreshFootnoteLayouts(fixture.plugin, fixture.file);
			expect(fixture.element.textContent).toContain("NEW definition.");
			expect(laterElement.textContent).toContain("NEW definition.");
			expect([...fixture.plugin.activeFootnoteRenders ?? []]).toEqual(owners);
			expect(fixture.vault.modify).not.toHaveBeenCalled();
		});

		it.each([
			{ label: "outer", target: "outer", quoted: false },
			{ label: "nested", target: "nested", quoted: false },
			{ label: "outer with quoted nested owner", target: "outer", quoted: true },
		])("rebases $label footnote owners after a successful nested source edit", async ({ target, quoted }) => {
			vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element) => { element.textContent = markdown; });
			const nestedSource = "Inner[^external]\n:::\nInner second";
			const nestedFence = quoted
				? `> \`\`\`colsdown\n${nestedSource.split("\n").map((line) => `> ${line}`).join("\n")}\n> \`\`\``
				: `\`\`\`colsdown\n${nestedSource}\n\`\`\``;
			const outerSource = `Outer[^external]\n${nestedFence}\n:::\nOuter second`;
			let note = `\`\`\`\`colsdown\n${outerSource}\n\`\`\`\`\n\n[^external]: OLD definition.`;
			const fixture = renderFixture(note, outerSource, "row", {
				cachedRead: async () => note,
				sectionInfo: { text: note, lineStart: 0, lineEnd: 9 },
			});
			Object.assign(fixture.vault, { read: vi.fn(async () => note) });
			fixture.vault.process.mockImplementation(async (_file: unknown, update: (text: string) => string) => { note = update(note); });
			document.body.append(fixture.element);
			await fixture.result;

			let nestedElement = fixture.element.querySelector<HTMLElement>(".layout-columns-root");
			if (quoted) {
				nestedElement = document.createElement("div");
				document.body.append(nestedElement);
				await api.renderLayout(fixture.plugin, nestedSource, nestedElement, {
					sourcePath: fixture.file.path,
					getSectionInfo: () => ({ text: note, lineStart: 2, lineEnd: 6 }),
					addChild: (child) => { children.push(child); },
				}, "row");
			}
			expect(nestedElement).not.toBeNull();
			const owners = [...fixture.plugin.activeFootnoteRenders ?? []];
			expect(owners).toHaveLength(2);

			resize(target === "outer" ? fixture.element : nestedElement!);
			await vi.waitFor(() => expect(fixture.vault.process).toHaveBeenCalledTimes(1));
			note = note.replace("OLD definition.", "NEW definition.");
			fixture.vault.cachedRead.mockImplementation(async () => note);
			await api.refreshFootnoteLayouts(fixture.plugin, fixture.file);

			expect(fixture.element.textContent).toContain("NEW definition.");
			const currentNested = quoted ? nestedElement : fixture.element.querySelector<HTMLElement>(".layout-columns-root");
			expect(currentNested!.textContent).toContain("NEW definition.");
			if (target === "nested") {
				expect(note).toContain("::: 55%");
				expect(currentNested!.querySelector<HTMLElement>(".layout-layout")!.style.gridTemplateColumns).toContain("55fr");
			}
			const currentOwners = [...fixture.plugin.activeFootnoteRenders ?? []];
			expect(currentOwners).toHaveLength(2);
			expect(currentOwners).toContain(owners[0]);
			if (quoted) expect(currentOwners).toEqual(owners);
			else expect(nestedElement!.isConnected).toBe(false);
		});

		it("recovers the direct owner after an initial validation failure and successful edit", async () => {
			vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element) => { element.textContent = markdown; });
			const source = "First[^external]\n:::\nSecond";
			let note = `\`\`\`colsdown\n${source}\n\`\`\`\n\n[^external]: OLD definition.`;
			const fixture = renderFixture(note, source, "row", {
				cachedRead: async () => note,
				sectionInfo: { text: "Stale section", lineStart: 0, lineEnd: 0 },
			});
			Object.assign(fixture.vault, { read: vi.fn(async () => note) });
			fixture.vault.process.mockImplementation(async (_file: unknown, update: (text: string) => string) => { note = update(note); });
			document.body.append(fixture.element);
			await fixture.result;
			expect(fixture.element.textContent).not.toContain("OLD definition.");

			resize(fixture.element);
			await vi.waitFor(() => expect(fixture.vault.process).toHaveBeenCalledTimes(1));
			note = note.replace("OLD definition.", "NEW definition.");
			fixture.vault.cachedRead.mockImplementation(async () => note);
			await api.refreshFootnoteLayouts(fixture.plugin, fixture.file);

			expect(fixture.element.textContent).toContain("NEW definition.");
		});

		it("shifts a validated quoted owner after adding a column to an earlier layout", async () => {
			vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element) => { element.textContent = markdown; });
			const source = "First[^external]\n:::\nSecond";
			const quotedSource = "Quoted[^external]\n:::\nFinal";
			let note = [
				"```colsdown", source, "```", "",
				"> ```colsdown", ...quotedSource.split("\n").map((line) => `> ${line}`), "> ```", "",
				"[^external]: OLD definition.",
			].join("\n");
			const fixture = renderFixture(note, source, "row", {
				cachedRead: async () => note,
				sectionInfo: { text: note, lineStart: 0, lineEnd: 4 },
			});
			Object.assign(fixture.vault, { read: vi.fn(async () => note) });
			fixture.vault.process.mockImplementation(async (_file: unknown, update: (text: string) => string) => { note = update(note); });
			document.body.append(fixture.element);
			await fixture.result;

			const quotedElement = document.createElement("div");
			document.body.append(quotedElement);
			await api.renderLayout(fixture.plugin, quotedSource, quotedElement, {
				sourcePath: fixture.file.path,
				getSectionInfo: () => ({ text: note, lineStart: 6, lineEnd: 10 }),
				addChild: (child) => { children.push(child); },
			}, "row");
			const owners = [...fixture.plugin.activeFootnoteRenders ?? []];

			fixture.element.querySelector<HTMLButtonElement>(".colsdown-add-column")!.click();
			await vi.waitFor(() => expect(fixture.vault.process).toHaveBeenCalledTimes(1));
			note = note.replace("OLD definition.", "NEW definition.");
			fixture.vault.cachedRead.mockImplementation(async () => note);
			await api.refreshFootnoteLayouts(fixture.plugin, fixture.file);

			expect(fixture.element.textContent).toContain("NEW definition.");
			expect(quotedElement.textContent).toContain("NEW definition.");
			expect([...fixture.plugin.activeFootnoteRenders ?? []]).toEqual(owners);
		});
	});

	describe("external footnote live refresh", () => {
		const source = "Text[^external]\n:::\nPlain text";
		const snapshot = (definition = "OLD definition.") => `\`\`\`colsdown\n${source}\n\`\`\`${definition ? `\n\n[^external]: ${definition}` : ""}`;

		function visibleRenderer() {
			return vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element) => {
				element.textContent = markdown;
			});
		}

		async function fixture() {
			visibleRenderer();
			const result = renderFixture(snapshot(), source);
			document.body.appendChild(result.element);
			await result.result;
			return result;
		}

		it("tracks named-reference ownership before the read and removes it on unload", async () => {
			const read = deferred<string>();
			const result = renderFixture("", "Text[^external]", "row", { cachedRead: () => read.promise });
			expect(result.plugin.activeFootnoteRenders?.size).toBe(1);
			expect([...result.plugin.activeFootnoteRenders ?? []][0]?.sourcePath).toBe("Example.md");
			children[children.length - 1]?.unload();
			expect(result.plugin.activeFootnoteRenders?.size).toBe(0);
			read.resolve("```colsdown\nText[^external]\n```\n\n[^external]: Definition");
			await result.result;
		});

		it.each(["Plain text", "Inline^[definition]"])("leaves %s outside source-change tracking", async (markdown) => {
			const result = renderFixture(`\`\`\`colsdown\n${markdown}\n\`\`\``, markdown);
			await result.result;
			expect(result.plugin.activeFootnoteRenders?.size ?? 0).toBe(0);
		});

		it.each(["markdown-preview-view", "cm-preview-code-block"])("updates definitions in an owned %s without rebuilding the layout", async (hostClass) => {
			const result = await fixture();
			result.element.classList.add(hostClass);
			const layout = result.element.querySelector(".layout-layout");
			const plainContent = result.element.querySelectorAll(".layout-content")[1];
			result.vault.cachedRead.mockResolvedValue(snapshot("NEW **bold** definition."));
			await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
			expect(result.element.textContent).toContain("NEW **bold** definition.");
			expect(result.element.textContent).not.toContain("OLD definition.");
			expect(result.element.querySelector(".layout-layout")).toBe(layout);
			expect(result.element.querySelectorAll(".layout-content")[1]).toBe(plainContent);
			expect(result.vault.cachedRead).toHaveBeenCalledTimes(2);
			expect(result.vault.modify).not.toHaveBeenCalled();
			expect(result.vault.process).not.toHaveBeenCalled();
			expect(result.vault.write).not.toHaveBeenCalled();
		});

		it.each(["full note", "heading section"] as const)("refreshes with retained %s metadata after initial validation", async (kind) => {
			visibleRenderer();
			const section = `### Target\n\n${snapshot()}`;
			const note = `# Before\n\n${section}`;
			const result = renderFixture(note, source, "row", {
				sectionInfo: kind === "full note"
					? { text: note, lineStart: 4, lineEnd: 8 }
					: { text: section, lineStart: 2, lineEnd: 6 },
			});
			await result.result;
			expect(result.element.textContent).toContain("OLD definition.");
			result.vault.cachedRead.mockResolvedValue(note.replace("OLD definition.", "NEW definition."));
			await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
			expect(result.element.textContent).toContain("NEW definition.");
			expect(result.element.textContent).not.toContain("OLD definition.");

			result.vault.cachedRead.mockResolvedValue(note.replace(source, "Different[^external]").replace("OLD definition.", "WRONG definition."));
			await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
			expect(result.element.textContent).toContain("NEW definition.");
			expect(result.element.textContent).not.toContain("WRONG definition.");
		});

		it("does not relocate a validated fence after lines are inserted above it", async () => {
			const result = await fixture();
			result.vault.cachedRead.mockResolvedValue(`# Inserted\n\n${snapshot("WRONG relocated definition.")}`);
			await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
			expect(result.element.textContent).toContain("OLD definition.");
			expect(result.element.textContent).not.toContain("WRONG relocated definition.");
			result.vault.cachedRead.mockResolvedValue(snapshot("RECOVERED definition."));
			await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
			expect(result.element.textContent).toContain("RECOVERED definition.");
		});

		it("does not establish provenance after invalid initial section mapping", async () => {
			visibleRenderer();
			const result = renderFixture(snapshot(), source, "row", {
				sectionInfo: { text: "Stale section", lineStart: 0, lineEnd: 0 },
			});
			await result.result;
			result.vault.cachedRead.mockResolvedValue(snapshot("WRONG definition."));
			await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
			expect(result.element.textContent).not.toContain("definition.");
		});

		it("removes stale footnotes when a valid snapshot has no definitions", async () => {
			const result = await fixture();
			result.vault.cachedRead.mockResolvedValue(snapshot(""));
			await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
			expect(result.element.textContent).not.toContain("OLD definition.");
			expect(result.element.textContent).toContain("Text[^external]");
		});

		it.each(["read rejection", "unmatched snapshot"])("preserves visible content on %s", async (failure) => {
			const result = await fixture();
			const content = result.element.querySelector(".layout-content");
			if (failure === "read rejection") result.vault.cachedRead.mockRejectedValue(new Error("unavailable"));
			else result.vault.cachedRead.mockResolvedValue("```colsdown\nDifferent body\n```\n[^external]: Wrong definition");
			await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
			expect(result.element.querySelector(".layout-content")).toBe(content);
			expect(result.element.textContent).toContain("OLD definition.");
		});

		it("skips renderer work when definitions and item inputs did not change", async () => {
			const render = visibleRenderer();
			const result = renderFixture(snapshot(), source);
			await result.result;
			await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
			expect(render).toHaveBeenCalledTimes(2);
		});

		it("ignores unrelated files and refreshes each matching owned layout independently", async () => {
			const result = await fixture();
			const first = vi.fn(async () => {});
			const second = vi.fn(async () => {});
			const unrelated = vi.fn(async () => {});
			result.plugin.activeFootnoteRenders = new Set([
				{ sourcePath: "Example.md", refresh: first, dispose: () => {} },
				{ sourcePath: "Example.md", refresh: second, dispose: () => {} },
				{ sourcePath: "Other.md", refresh: unrelated, dispose: () => {} },
			]);
			await api.refreshFootnoteLayouts(result.plugin, { path: "Unrelated.md" });
			expect(first).not.toHaveBeenCalled();
			await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
			expect(first).toHaveBeenCalledTimes(1);
			expect(second).toHaveBeenCalledTimes(1);
			expect(unrelated).not.toHaveBeenCalled();
		});

		it("does not let a failed owned refresh starve another layout", async () => {
			const result = await fixture();
			const second = vi.fn(async () => {});
			const log = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				result.plugin.activeFootnoteRenders = new Set([
					{ sourcePath: "Example.md", refresh: async () => { throw new Error("failed"); }, dispose: () => {} },
					{ sourcePath: "Example.md", refresh: second, dispose: () => {} },
				]);
				await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
				expect(second).toHaveBeenCalledTimes(1);
				expect(log).toHaveBeenCalled();
			} finally { log.mockRestore(); }
		});

		it("discards a late refresh read after ownership is unloaded", async () => {
			const result = await fixture();
			const before = result.element.textContent;
			const read = deferred<string>();
			result.vault.cachedRead.mockImplementation(() => read.promise);
			const refresh = api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
			children[children.length - 1]?.unload();
			read.resolve(snapshot("LATE definition."));
			await refresh;
			expect(result.element.textContent).toBe(before);
			expect(result.plugin.activeFootnoteRenders?.size).toBe(0);
		});

		it("keeps the newest refresh when a newer event arrives during a read", async () => {
			const result = await fixture();
			const older = deferred<string>();
			result.vault.cachedRead.mockImplementationOnce(() => older.promise).mockResolvedValue(snapshot("NEWEST definition."));
			const oldRefresh = api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
			await vi.waitFor(() => expect(result.vault.cachedRead).toHaveBeenCalledTimes(2));
			const latestRefresh = api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
			older.resolve(snapshot("OLDER definition."));
			await Promise.all([oldRefresh, latestRefresh]);
			expect(result.element.textContent).toContain("NEWEST definition.");
			expect(result.element.textContent).not.toContain("OLDER definition.");
			expect(result.element.querySelectorAll(".layout-content")).toHaveLength(2);
		});

		it("keeps the newest refresh when a newer event arrives during staged rendering", async () => {
			const result = await fixture();
			const olderRender = deferred<void>();
			vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element) => {
				if (markdown.includes("OLDER definition.")) await olderRender.promise;
				element.textContent = markdown;
			});
			result.vault.cachedRead.mockResolvedValueOnce(snapshot("OLDER definition.")).mockResolvedValue(snapshot("NEWEST definition."));
			const oldRefresh = api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
			await vi.waitFor(() => expect(ObsidianMock.MarkdownRenderer.render).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("OLDER definition."), expect.anything(), "Example.md", expect.anything()));
			const latestRefresh = api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
			olderRender.resolve();
			await Promise.all([oldRefresh, latestRefresh]);
			expect(result.element.textContent).toContain("NEWEST definition.");
			expect(result.element.textContent).not.toContain("OLDER definition.");
			expect(result.element.querySelectorAll(".layout-content")).toHaveLength(2);
		});

		 it("preserves all visible items when one staged render fails, then recovers", async () => {
			const pair = "First[^external]\n:::\nSecond[^external]";
			const note = (value: string) => `\`\`\`colsdown\n${pair}\n\`\`\`\n\n[^external]: ${value}`;
			visibleRenderer();
			const result = renderFixture(note("OLD definition."), pair);
			document.body.appendChild(result.element);
			await result.result;
			const oldContents = Array.from(result.element.querySelectorAll(".layout-content"));
			const oldChildren = vi.mocked(ObsidianMock.MarkdownRenderer.render).mock.calls.map((call) => call[4]);
			const oldUnloads = oldChildren.map((child) => vi.spyOn(child, "unload"));
			const log = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element) => {
					if (markdown.startsWith("Second") && markdown.includes("FAIL definition.")) throw new Error("second item failed");
					element.textContent = markdown;
				});
				result.vault.cachedRead.mockResolvedValue(note("FAIL definition."));
				await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
				expect(Array.from(result.element.querySelectorAll(".layout-content"))).toEqual(oldContents);
				expect(result.element.textContent).not.toContain("FAIL definition.");
				expect(log).toHaveBeenCalled();
				for (const unload of oldUnloads) expect(unload).not.toHaveBeenCalled();
				result.vault.cachedRead.mockResolvedValue(note("RECOVERED definition."));
				await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
				expect(result.element.querySelectorAll(".layout-content")).toHaveLength(2);
				expect(result.element.textContent).not.toContain("OLD definition.");
				expect(result.element.textContent?.match(/RECOVERED definition/g)).toHaveLength(2);
				for (const unload of oldUnloads) expect(unload).toHaveBeenCalledTimes(1);
			} finally { log.mockRestore(); }
		});

		it("renders attached staging with host ancestry and removes staging attributes on commit", async () => {
			const result = await fixture();
			const host = document.createElement("div");
			host.className = "cm-embed-block";
			document.body.appendChild(host);
			host.appendChild(result.element);
			let stagedChild: ObsidianMock.MarkdownRenderChild | undefined;
			vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element, _path, child) => {
				expect(element.closest(".layout-columns-root")).toBe(result.element);
				expect(element.closest(".cm-embed-block")).toBe(host);
				expect(element.getAttribute("aria-hidden")).toBe("true");
				expect(element.classList.contains("colsdown-footnote-staging")).toBe(true);
				stagedChild = child;
				element.textContent = markdown;
			});
			result.vault.cachedRead.mockResolvedValue(snapshot("NEW definition."));
			await api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
			const content = result.element.querySelector<HTMLElement>(".layout-content");
			expect(content).toBe(stagedChild?.containerEl);
			expect(content?.hasAttribute("aria-hidden")).toBe(false);
			expect(content?.classList.contains("colsdown-footnote-staging")).toBe(false);
			expect(content?.style.visibility).toBe("");
			expect(content?.style.height).toBe("");
			expect(content?.style.overflow).toBe("");
			expect(content?.style.pointerEvents).toBe("");
		});

		it("discards staged content and unloads its child when the owner unloads mid-render", async () => {
			const result = await fixture();
			const oldContent = result.element.querySelector(".layout-content");
			const gate = deferred<void>();
			let stagingUnload: MockInstance<() => void> | undefined;
			vi.spyOn(ObsidianMock.MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element, _path, child) => {
				stagingUnload = vi.spyOn(child, "unload");
				await gate.promise;
				element.textContent = markdown;
			});
			result.vault.cachedRead.mockResolvedValue(snapshot("LATE definition."));
			const refresh = api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
			await vi.waitFor(() => expect(stagingUnload).toBeDefined());
			children[children.length - 1]?.unload();
			gate.resolve();
			await refresh;
			expect(result.element.querySelector(".layout-content")).toBe(oldContent);
			expect(result.element.querySelectorAll(".layout-content")).toHaveLength(2);
			expect(result.element.textContent).not.toContain("LATE definition.");
			expect(stagingUnload).toHaveBeenCalled();
		});

		it("settles on the latest definition when modification arrives during initial reading", async () => {
			visibleRenderer();
			const firstRead = deferred<string>();
			const result = renderFixture("", source, "row", {
				cachedRead: () => firstRead.promise,
				sectionInfo: { text: snapshot("OUTDATED initial definition."), lineStart: 0, lineEnd: 4 },
			});
			document.body.appendChild(result.element);
			result.vault.cachedRead.mockResolvedValue(snapshot("LATEST initial definition."));
			const refresh = api.refreshFootnoteLayouts(result.plugin, { path: "Example.md" });
			firstRead.resolve(snapshot("OUTDATED initial definition."));
			await Promise.all([result.result, refresh]);
			expect(result.element.textContent).toContain("LATEST initial definition.");
			expect(result.element.textContent).not.toContain("OUTDATED initial definition.");
		});

		it("unloads the current native item children through the plugin-owned disposer", async () => {
			const result = await fixture();
			const itemChildren = vi.mocked(ObsidianMock.MarkdownRenderer.render).mock.calls.map((call) => call[4]);
			const unloads = itemChildren.map((child) => vi.spyOn(child, "unload"));
			const record = [...result.plugin.activeFootnoteRenders ?? []][0];
			record?.dispose();
			for (const unload of unloads) expect(unload).toHaveBeenCalledTimes(1);
			expect(result.plugin.activeFootnoteRenders?.size).toBe(0);
		});

		it("registers one modify listener and disposes owned refreshes with plugin lifecycle", async () => {
			const callbacks = new Set<(file: { path: string }) => Promise<void> | void>();
			const vault = {
				on: vi.fn((_event: string, callback: (file: { path: string }) => Promise<void> | void) => { callbacks.add(callback); return { e: vault, callback }; }),
				offref: (event: unknown) => callbacks.delete((event as { callback: (file: { path: string }) => Promise<void> | void }).callback),
			};
			const Constructor = api as unknown as new () => ObsidianMock.Plugin & {
				onload: () => Promise<void>;
				activeFootnoteRenders?: RenderPlugin["activeFootnoteRenders"];
			};
			const instance = new Constructor();
			instance.app = { vault, workspace: { getLeavesOfType: () => [] } };
			await instance.onload();
			expect(vault.on).toHaveBeenCalledTimes(1);
			expect(vault.on.mock.calls[0]?.[0]).toBe("modify");
			const refresh = vi.fn(async () => {});
			const dispose = vi.fn();
			instance.activeFootnoteRenders = new Set([{ sourcePath: "Example.md", refresh, dispose }]);
			for (const callback of callbacks) await callback({ path: "Example.md" });
			expect(refresh).toHaveBeenCalledTimes(1);
			instance.unload();
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(callbacks.size).toBe(0);
			expect(instance.activeFootnoteRenders?.size ?? 0).toBe(0);
		});
	});
});

describe("Reference definition hydration", () => {
  const references = require("../src/footnotes.cjs") as {
    collectReferenceDefinitions: (source: string) => Map<string, string>;
    hydrateReferenceDefinitions: (source: string, definitions: Map<string, string>) => string;
  };
  it("keeps full-note frontmatter opaque while collecting definitions in a thematic column fragment", () => {
    const api = require("../src/footnotes.cjs") as {
      collectFootnoteDefinitions: (source: string, options?: { fragment?: boolean }) => Map<string, string>;
      collectReferenceDefinitions: (source: string, options?: { fragment?: boolean }) => Map<string, string>;
    };
    const source = "---\n\n[docs]: https://example.com/docs\n\n[^shared]: Fragment definition.\n\n---";
    expect(api.collectFootnoteDefinitions(source).size).toBe(0); expect(api.collectReferenceDefinitions(source).size).toBe(0);
    expect(api.collectFootnoteDefinitions(source, { fragment: true }).get("shared")).toContain("Fragment definition.");
    expect(api.collectReferenceDefinitions(source, { fragment: true }).get("docs")).toContain("https://example.com/docs");
  });
  it("collects complete raw multiline definitions with normalized labels and first-definition precedence", () => {
    const raw = '[Docs]: <https://example.com/docs>\r\n  "Documentation\r\n  second line"\r\n';
    const source = `${raw}\r\n[docs]: https://example.com/later\r\n`;
    const collected = references.collectReferenceDefinitions(source);
    expect(collected.size).toBe(1); expect(collected.get("docs")).toBe(raw);
  });
  it("collects consecutive reference definitions without treating the second as paragraph content", () => {
    const source = "[one]: https://example.com/one\n[two]: https://example.com/two\n\nParagraph\n[ordinary]: paragraph continuation";
    const collected = references.collectReferenceDefinitions(source);
    expect(Array.from(collected.keys())).toEqual(["one", "two"]);
    expect(collected.get("one")).toBe("[one]: https://example.com/one\n");
    expect(collected.get("two")).toBe("[two]: https://example.com/two\n");
  });
  it("ignores reference-like definitions in code and comments", () => {
    const source = '[visible]: https://example.com/visible\n\n```text\n[fenced]: hidden\n```\n\n<!--\n[html]: hidden\n-->\n\n%%\n[percent]: hidden\n%%\n\n`[inline]: hidden`';
    expect(Array.from(references.collectReferenceDefinitions(source).keys())).toEqual(["visible"]);
  });
  it("keeps local definitions authoritative and appends only missing normalized labels", () => {
    const source = '[docs]: https://example.com/local\n\n[Link][DOCS] and ![image][image].';
    const hydrated = references.hydrateReferenceDefinitions(source, new Map([
      [" DOCS ", "[Docs]: https://example.com/external"], ["image", "[image]: https://example.com/image.png"],
    ]));
    expect(hydrated.startsWith(source)).toBe(true); expect(hydrated).not.toContain("https://example.com/external");
    expect(references.collectReferenceDefinitions(hydrated).get("docs")).toContain("https://example.com/local");
    expect(references.collectReferenceDefinitions(hydrated).get("image")).toContain("https://example.com/image.png");
  });
  it.each(["```text\nUnclosed", "<!--\nUnclosed"])("prefixes references before an opaque tail without changing its source: %j", (suffix) => {
    const source = `[Link][docs]\n\n${suffix}`;
    const definition = '[docs]: https://example.com/docs "Documentation"';
    const hydrated = references.hydrateReferenceDefinitions(source, new Map([["docs", definition]]));
    expect(hydrated.endsWith(source)).toBe(true); expect(hydrated.indexOf(definition)).toBeLessThan(hydrated.indexOf("[Link][docs]"));
    expect(references.collectReferenceDefinitions(hydrated).get("docs")).toContain(definition);
  });
});

describe("Footnote hydration", () => {
	interface FootnoteApi {
		collectFootnoteDefinitions: (source: string) => Map<string, string>;
		hydrateFootnotes: (source: string, definitions: Map<string, string>) => string;
	}

	const footnotes = require("../src/footnotes.cjs") as FootnoteApi;

	const definitions = new Map([["note", "[^note]: External definition."]]);

	describe("hydration outside trailing opaque blocks", () => {
		it.each(["`````text\nunclosed", "~~~~~text\nunclosed", "$$\nunclosed", "<!--\nunclosed", "<script>\nunclosed", "<?processing\nunclosed", "<![CDATA[\nunclosed", "<!DECLARATION\nunclosed", "%% unclosed"])("prefixes missing definitions without closing the trailing construct %s", (tail) => {
			const source = `Use[^note]\n\n${tail}`;
			const hydrated = footnotes.hydrateFootnotes(source, definitions);
			expect(hydrated).toBe(`[^note]: External definition.\n\n<!-- -->\n\n${source}`);
			expect(footnotes.collectFootnoteDefinitions(hydrated).get("note")).toBe("[^note]: External definition.\n");
		});

		it.each(["<div>\nHTML", "    indented code", "Text <!-- literal opener", "```text\nclosed\n```"])("keeps ordinary append behavior when a blank line exposes definitions: %s", (tail) => {
			const source = `Use[^note]\n\n${tail}`;
			expect(footnotes.hydrateFootnotes(source, definitions)).toBe(`${source}\n\n[^note]: External definition.`);
		});

		it("adds a blank line after a single terminal CRLF", () => {
			expect(footnotes.hydrateFootnotes("Use[^note]\r\n", definitions)).toBe("Use[^note]\r\n\r\n[^note]: External definition.");
		});

		it("keeps local definitions authoritative during prefix fallback", () => {
			const source = "Use[^local] and external[^note].\n\n[^local]: Local definition.\n\n```text\nunclosed";
			const hydrated = footnotes.hydrateFootnotes(source, new Map([...definitions, ["local", "[^local]: Other definition."]]));
			expect(hydrated).toBe(`[^note]: External definition.\n\n<!-- -->\n\n${source}`);
		});

		it.each(["[^host]: [^nested]: Local.", "[^host]:\n    [^nested]: Local."])("keeps nested item-local definitions authoritative: %s", (body) => {
			const source = `Use[^nested]\n\n${body}`;
			expect(footnotes.hydrateFootnotes(source, new Map([["nested", "[^nested]: External."]]))).toBe(source);
		});

		it("preserves nested local authority while prefixing a different missing definition", () => {
			const source = "Use[^nested] and external[^note].\n\n[^host]: [^nested]: Local.\n\n```text\nunclosed";
			const hydrated = footnotes.hydrateFootnotes(source, new Map([...definitions, ["nested", "[^nested]: External."]]));
			expect(hydrated).toBe(`[^note]: External definition.\n\n<!-- -->\n\n${source}`);
		});

		it("keeps definitions in a nested footnote layout separate from item-local definitions", () => {
			const source = "Use[^nested]\n\n[^host]: ```stack\n    [^nested]: Inside layout.\n    ```";
			const hydrated = footnotes.hydrateFootnotes(source, new Map([["nested", "[^nested]: Shared definition."]]));
			expect(hydrated).toBe(`${source}\n\n[^nested]: Shared definition.`);
		});

		it.each(["    leading code", "\tleading code", "    - indented list"])("keeps leading indented content outside the injected definition: %s", (leading) => {
			const source = `${leading}\n\nUse[^note]\n\n\`\`\`text\nunclosed`;
			const hydrated = footnotes.hydrateFootnotes(source, definitions);
			expect(hydrated).toBe(`[^note]: External definition.\n\n<!-- -->\n\n${source}`);
			expect(footnotes.collectFootnoteDefinitions(hydrated).get("note")).toBe("[^note]: External definition.\n");
		});

		it("preserves leading frontmatter and CRLF before the fallback prefix", () => {
			const header = "\uFEFF---\r\ntitle: Example\r\n---\r\n";
			const body = "Use[^note]\r\n\r\n```text\r\nunclosed";
			const hydrated = footnotes.hydrateFootnotes(header + body, definitions);
			expect(hydrated).toBe(`${header}\r\n[^note]: External definition.\r\n\r\n<!-- -->\r\n\r\n${body}`);
			expect(footnotes.collectFootnoteDefinitions(hydrated).has("note")).toBe(true);
		});

		it("preserves a standalone leading BOM during fallback", () => {
			const body = "Use[^note]\n\n```text\nunclosed";
			const hydrated = footnotes.hydrateFootnotes(`\uFEFF${body}`, definitions);
			expect(hydrated).toBe(`\uFEFF\n\n[^note]: External definition.\n\n<!-- -->\n\n${body}`);
			expect(footnotes.collectFootnoteDefinitions(hydrated).has("note")).toBe(true);
		});

		it("keeps a nested layout body unchanged before an open trailing fence", () => {
			const source = "Use[^note]\n\n```stack\nNested content\n```\n\n`````text\nunclosed";
			expect(footnotes.hydrateFootnotes(source, definitions)).toBe(`[^note]: External definition.\n\n<!-- -->\n\n${source}`);
		});
	});
});

//#endregion
