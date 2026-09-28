import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

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

const require = createRequire(import.meta.url);
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
