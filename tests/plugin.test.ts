import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import Module from "node:module";
import { describe, expect, it, vi } from "vitest";
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

//#region Settings, commands, and presets

describe("Settings normalization", () => {
	const { CANONICAL_SEPARATOR, MAX_SEPARATOR_LENGTH, isValidSeparator, normalizeSettings } = require("../src/main.cjs") as {
		CANONICAL_SEPARATOR: string;
		MAX_SEPARATOR_LENGTH: number;
		isValidSeparator: (value: unknown) => boolean;
		normalizeSettings: (value: Record<string, unknown>) => Record<string, unknown>;
	};
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

describe("Saved presets", () => {
	interface Preset {
		id: string;
		name: string;
		layout: "colsdown" | "stack";
		widths: string[];
	}

	interface Command {
		id: string;
		name: string;
		editorCallback: (editor: { replaceSelection: (value: string) => void }) => void;
	}

	interface PresetsApi {
		normalizePresets: (value: unknown) => Preset[];
		syncPresetCommands: (plugin: FakePlugin) => void;
		renderPresetSettings: (container: HTMLElement, plugin: FakePlugin) => HTMLElement;
	}

	class FakePlugin {
		settings: { separator: string; presets: Preset[] };
		commands = new Map<string, Command>();
		removed: string[] = [];
		failSave = false;

		constructor(presets: Preset[] = []) {
			this.settings = { separator: ":::" , presets };
		}

		addCommand(command: Command): void {
			const rawId = command.id;
			this.commands.set(rawId, { ...command });
			command.id = `colsdown:${command.id}`;
			command.name = `Colsdown: ${command.name}`;
		}

		removeCommand(id: string): void {
			this.removed.push(id);
			this.commands.delete(id);
		}

		async updateSettings(patch: { presets: Preset[] }): Promise<void> {
			if (this.failSave) throw new Error("disk full");
			this.settings = { ...this.settings, ...patch };
			syncPresetCommands(this);
		}
	}

	let presetsApi: PresetsApi;

		presetsApi = require("../src/presets.cjs") as PresetsApi;

	const { normalizePresets, renderPresetSettings, syncPresetCommands } = presetsApi;

	function clickByText(root: HTMLElement, text: string): void {
		const button = Array.from(root.querySelectorAll("button")).find((item) => item.textContent === text);
		if (!button) throw new Error(`Missing ${text} button`);
		button.click();
	}

	function clickByLabel(root: HTMLElement, label: string): void {
		const control = root.querySelector<HTMLElement>(`[aria-label="${label}"]`);
		if (!control) throw new Error(`Missing ${label} control`);
		control.click();
	}

	function chooseLayout(root: HTMLElement, layout: "colsdown" | "stack"): void {
		const label = layout === "colsdown" ? "Columns" : "Stack";
		const tab = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
			.find((button) => button.textContent === label);
		if (!tab) throw new Error(`Missing ${layout} layout choice`);
		tab.click();
	}

	function widthInput(root: HTMLElement, column: number): HTMLInputElement {
		const input = root.querySelector<HTMLInputElement>(`[aria-label="Column ${column} width"]`);
		if (!input) throw new Error(`Missing column ${column} width`);
		return input;
	}

	async function submit(root: HTMLElement): Promise<void> {
		root.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		await vi.waitFor(() => expect(root.getAttribute("aria-busy")).toBeNull());
	}

	describe("preset normalization", () => {
		it("migrates valid stored presets and rejects malformed or duplicate entries", () => {
			const result = normalizePresets([
				{ id: "stable-id", name: " Focus ", layout: "colsdown", widths: ["30%", "70%"] },
				{ id: "other", name: "focus", layout: "stack", widths: ["", ""] },
				{ id: "stack-id", name: "Sections", layout: "stack", widths: ["ignored", "ignored", "ignored"] },
				{ id: "bad", name: "Bad", layout: "colsdown", widths: ["90%", "90%"] },
			]);

			expect(result).toEqual([
				{ id: "stable-id", name: "Focus", layout: "colsdown", widths: ["30%", "70%"] },
				{ id: "stack-id", name: "Sections", layout: "stack", widths: ["", "", ""] },
			]);
			expect(normalizePresets(undefined)).toEqual([]);
		});

		it("replaces unsafe stored IDs with bounded command-safe UUIDs", () => {
			const [preset] = normalizePresets([
				{ id: "unsafe id:with spaces", name: "Safe", layout: "stack", widths: ["", ""] },
			]);
			expect(preset?.id).toMatch(/^[A-Za-z0-9_-]{1,80}$/);
		});
	});

	describe("preset commands", () => {
		it("keeps raw stable IDs for removal and reads current preset values", () => {
			const plugin = new FakePlugin([
				{ id: "fixed-id", name: "Sidebar", layout: "colsdown", widths: ["30%", "70%"] },
			]);
			syncPresetCommands(plugin);
			const rawId = "insert-preset-fixed-id";
			const command = plugin.commands.get(rawId);
			expect(command?.id).toBe(rawId);

			plugin.settings.presets[0] = { id: "fixed-id", name: "Renamed", layout: "stack", widths: ["", "", ""] };
			const replaceSelection = vi.fn();
			command?.editorCallback({ replaceSelection });
			expect(replaceSelection).toHaveBeenCalledWith(
				"```stack\n:::\nSection 1\n\n:::\nSection 2\n\n:::\nSection 3\n```",
			);

			syncPresetCommands(plugin);
			expect(plugin.removed).toEqual([rawId]);
			expect(plugin.commands.get(rawId)?.name).toBe("Insert preset: Renamed");
		});

		it("does not re-register unchanged commands", () => {
			const plugin = new FakePlugin([
				{ id: "fixed-id", name: "Sidebar", layout: "colsdown", widths: ["30%", "70%"] },
			]);
			const add = vi.spyOn(plugin, "addCommand");
			syncPresetCommands(plugin);
			syncPresetCommands(plugin);
			expect(add).toHaveBeenCalledTimes(1);
			expect(plugin.removed).toEqual([]);
		});
	});

	describe("preset settings", () => {
		it.each(["new", "existing"])("keeps the %s preset draft open until Save or Cancel", async (mode) => {
			const existing = { id: "one", name: "Existing", layout: "colsdown" as const, widths: ["", ""] };
			const plugin = new FakePlugin(mode === "existing" ? [existing] : []);
			const save = vi.spyOn(plugin, "updateSettings");
			const container = document.body.appendChild(document.createElement("div"));
			try {
				const root = renderPresetSettings(container, plugin);
				const open = () => clickByText(root, mode === "existing" ? "Edit" : "Add preset");
				open();
				const form = root.querySelector("form");
				const name = root.querySelector<HTMLInputElement>('[aria-label="Preset name"]')!;
				name.value = "Draft";
				name.dispatchEvent(new Event("input", { bubbles: true }));
				widthInput(root, 1).value = "25%";
				widthInput(root, 1).dispatchEvent(new Event("input", { bubbles: true }));
				const expectDraftOpen = async () => {
					await Promise.resolve();
					expect(save).not.toHaveBeenCalled();
					expect(root.querySelector("form")).toBe(form);
					expect(name.value).toBe("Draft");
				};
				await expectDraftOpen();
				chooseLayout(root, "stack");
				await expectDraftOpen();
				clickByLabel(root, "Add section");
				await expectDraftOpen();
				clickByLabel(root, "Remove section 3");
				await expectDraftOpen();
				chooseLayout(root, "colsdown");
				await expectDraftOpen();
				expect(widthInput(root, 1).value).toBe("25%");
				clickByLabel(root, "Add column");
				await expectDraftOpen();
				clickByLabel(root, "Remove column 3");
				await expectDraftOpen();
				clickByText(root, "Cancel");
				expect(root.querySelector("form")).toBeNull();
				expect(save).not.toHaveBeenCalled();
				expect(plugin.settings.presets).toEqual(mode === "existing" ? [existing] : []);

				open();
				(root.querySelector('[aria-label="Preset name"]') as HTMLInputElement).value = "Saved";
				clickByText(root, "Save");
				await vi.waitFor(() => expect(root.querySelector("form")).toBeNull());
				expect(save).toHaveBeenCalledTimes(1);
				expect(plugin.settings.presets[0]?.name).toBe("Saved");
			} finally {
				container.remove();
			}
		});

		it("adds, edits, reloads, and deletes presets while keeping rename IDs", async () => {
			const plugin = new FakePlugin();
			const root = renderPresetSettings(document.createElement("div"), plugin);
			expect(root.textContent).toContain("No presets yet.");

			clickByText(root, "Add preset");
			(root.querySelector('input[type="text"]') as HTMLInputElement).value = "Sidebar";
			widthInput(root, 1).value = "30%";
			widthInput(root, 2).value = "70%";
			await submit(root);
			expect(plugin.settings.presets).toHaveLength(1);
			const id = plugin.settings.presets[0]?.id;
			expect(id).toMatch(/^[0-9a-f-]{36}$/);
			expect(plugin.commands.has(`insert-preset-${id}`)).toBe(true);

			expect(root.querySelector('[aria-label="Edit Sidebar preset"]')).not.toBeNull();
			expect(root.querySelector('[aria-label="Delete Sidebar preset"]')).not.toBeNull();
			clickByText(root, "Edit");
			(root.querySelector('input[type="text"]') as HTMLInputElement).value = "Reading";
			chooseLayout(root, "stack");
			clickByLabel(root, "Add section");
			clickByLabel(root, "Add section");
			await submit(root);
			expect(plugin.settings.presets[0]).toEqual({ id, name: "Reading", layout: "stack", widths: ["", "", "", ""] });

			const reloaded = renderPresetSettings(document.createElement("div"), plugin);
			expect(reloaded.textContent).toContain("Reading");
			clickByText(reloaded, "Delete");
			await vi.waitFor(() => expect(plugin.settings.presets).toEqual([]));
			expect(plugin.removed[plugin.removed.length - 1]).toBe(`insert-preset-${id}`);
		});

		it("shows validation errors and leaves settings unchanged", async () => {
			const existing = { id: "one", name: "Existing", layout: "colsdown" as const, widths: ["", ""] };
			const plugin = new FakePlugin([existing]);
			const root = renderPresetSettings(document.createElement("div"), plugin);
			clickByText(root, "Add preset");
			(root.querySelector('input[type="text"]') as HTMLInputElement).value = "existing";
			await submit(root);
			expect(root.textContent).toContain("Preset names must be unique.");
			expect(plugin.settings.presets).toEqual([existing]);

			(root.querySelector('input[type="text"]') as HTMLInputElement).value = "Invalid widths";
			widthInput(root, 1).value = "90%";
			widthInput(root, 2).value = "90%";
			await submit(root);
			expect(root.textContent).toContain("Percentage widths must add up to 100%.");
			expect(plugin.settings.presets).toEqual([existing]);
		});

		it("uses row controls, preserves column drafts across layout switches, and restores part focus", () => {
			const plugin = new FakePlugin();
			const container = document.body.appendChild(document.createElement("div"));
			try {
				const root = renderPresetSettings(container, plugin);
				clickByText(root, "Add preset");
				const tablist = root.querySelector('[role="tablist"]') as HTMLElement;
				const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
				expect(tablist.getAttribute("aria-label")).toBe("Layout");
				expect(tabs.map((tab) => tab.textContent)).toEqual(["Columns", "Stack"]);
				expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
				expect(tabs[0]?.tabIndex).toBe(0);
				expect(tabs[1]?.tabIndex).toBe(-1);
				const panel = root.querySelector('[role="tabpanel"]') as HTMLElement;
				expect(tabs[0]?.getAttribute("aria-controls")).toBe(panel.id);
				expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0]?.id);
				expect(root.querySelector(".colsdown-presets__layout.setting-item")?.querySelector(".setting-item-name")?.textContent)
					.toBe("Layout");
				expect(root.querySelector(".colsdown-presets__footer")?.children).toHaveLength(2);
				expect(root.querySelector(".colsdown-presets__footer > .colsdown-presets__add-part")).not.toBeNull();
				expect(root.querySelector(".colsdown-presets__footer > .colsdown-presets__actions")).not.toBeNull();
				widthInput(root, 1).value = "25";
				widthInput(root, 2).value = "75%";

				clickByLabel(root, "Add column");
				expect(document.activeElement?.getAttribute("aria-label")).toBe("Column 3 width");
				widthInput(root, 3).value = "2fr";
				chooseLayout(root, "stack");
				expect(root.textContent).toContain("Section 3");
				clickByLabel(root, "Add section");
				expect(root.textContent).toContain("Section 4");

				chooseLayout(root, "colsdown");
				expect(Array.from(root.querySelectorAll(".colsdown-presets__width"), (input) => (input as HTMLInputElement).value))
					.toEqual(["25", "75%", "2fr", ""]);
				clickByLabel(root, "Remove column 2");
				expect(Array.from(root.querySelectorAll(".colsdown-presets__width"), (input) => (input as HTMLInputElement).value))
					.toEqual(["25", "2fr", ""]);
				expect(document.activeElement?.getAttribute("aria-label")).toBe("Column 2 width");

				chooseLayout(root, "stack");
				clickByLabel(root, "Remove section 3");
				expect(document.activeElement?.getAttribute("aria-label")).toBe("Add section");
			} finally {
				container.remove();
			}
		});

		it("supports roving keyboard navigation across layout tabs", () => {
			const plugin = new FakePlugin();
			const container = document.body.appendChild(document.createElement("div"));
			try {
				const root = renderPresetSettings(container, plugin);
				clickByText(root, "Add preset");
				const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
				const [columns, stack] = tabs;
				columns?.focus();
				columns?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
				expect(stack?.getAttribute("aria-selected")).toBe("true");
				expect(document.activeElement).toBe(stack);

				stack?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
				expect(columns?.getAttribute("aria-selected")).toBe("true");
				expect(document.activeElement).toBe(columns);

				columns?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
				expect(document.activeElement).toBe(stack);
				stack?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
				expect(document.activeElement).toBe(columns);
			} finally {
				container.remove();
			}
		});

		it("enforces the two-to-twenty part limits", () => {
			const plugin = new FakePlugin();
			const root = renderPresetSettings(document.createElement("div"), plugin);
			clickByText(root, "Add preset");
			expect(root.querySelector('[aria-label="Add column"] svg')?.getAttribute("data-icon")).toBe("plus");
			expect(root.querySelector('[aria-label="Remove column 1"] svg')?.getAttribute("data-icon")).toBe("minus");
			expect((root.querySelector('[aria-label="Remove column 1"]') as HTMLButtonElement).disabled).toBe(true);
			for (let index = 2; index < 20; index += 1) clickByLabel(root, "Add column");
			expect(root.querySelectorAll(".colsdown-presets__width")).toHaveLength(20);
			expect((root.querySelector('[aria-label="Add column"]') as HTMLButtonElement).disabled).toBe(true);

			clickByLabel(root, "Remove column 20");
			expect(root.querySelectorAll(".colsdown-presets__width")).toHaveLength(19);
			expect((root.querySelector('[aria-label="Add column"]') as HTMLButtonElement).disabled).toBe(false);
		});

		it("normalizes bare numbers on save and shows a non-error saved cue", async () => {
			const plugin = new FakePlugin();
			const root = renderPresetSettings(document.createElement("div"), plugin);
			clickByText(root, "Add preset");
			(root.querySelector('.colsdown-presets__field input[type="text"]') as HTMLInputElement).value = "Numeric";
			widthInput(root, 1).value = "30";
			widthInput(root, 2).value = "70";
			await submit(root);

			expect(plugin.settings.presets[0]?.widths).toEqual(["30%", "70%"]);
			const status = root.querySelector(".colsdown-presets__status") as HTMLElement;
			expect(status.textContent).toBe("Preset saved.");
			expect(status.getAttribute("aria-live")).toBe("polite");
			expect(status.classList.contains("is-error")).toBe(false);
			const cue = root.querySelector(".colsdown-presets__saved") as HTMLElement;
			expect(cue.getAttribute("aria-hidden")).toBe("true");
			expect(cue.querySelector("svg")?.getAttribute("data-icon")).toBe("check");
			expect(root.querySelector(".colsdown-presets__item.setting-item .setting-item-name")?.textContent).toContain("Numeric");
			expect(root.querySelector(".colsdown-presets__item.setting-item .setting-item-description")?.textContent).toBe("30%, 70%");
		});

		it("accepts blank and auto column widths", async () => {
			const plugin = new FakePlugin();
			const root = renderPresetSettings(document.createElement("div"), plugin);
			clickByText(root, "Add preset");
			(root.querySelector('.colsdown-presets__field input[type="text"]') as HTMLInputElement).value = "Automatic";
			widthInput(root, 1).value = "";
			widthInput(root, 2).value = "auto";
			await submit(root);
			expect(plugin.settings.presets[0]?.widths).toEqual(["", ""]);
		});

		it("keeps a rejected draft editable without showing saved state", async () => {
			const existing = { id: "one", name: "Existing", layout: "colsdown" as const, widths: ["30%", "70%"] };
			const plugin = new FakePlugin([existing]);
			plugin.failSave = true;
			const root = renderPresetSettings(document.createElement("div"), plugin);
			clickByText(root, "Edit");
			widthInput(root, 1).value = "25";
			widthInput(root, 2).value = "50";
			clickByLabel(root, "Add column");
			await submit(root);
			await vi.waitFor(() => expect(root.textContent).toContain("Could not save presets: disk full"));

			expect(plugin.settings.presets).toEqual([existing]);
			expect(root.querySelector("form")).not.toBeNull();
			expect(widthInput(root, 1).value).toBe("25");
			expect(widthInput(root, 2).value).toBe("50");
			expect(widthInput(root, 3).disabled).toBe(false);
			expect((root.querySelector('[aria-label="Add column"]') as HTMLButtonElement).disabled).toBe(false);
			clickByLabel(root, "Add column");
			expect(root.querySelectorAll(".colsdown-presets__width")).toHaveLength(4);
			clickByLabel(root, "Remove column 4");
			expect(root.querySelectorAll(".colsdown-presets__width")).toHaveLength(3);
			expect(root.querySelector(".colsdown-presets__saved")).toBeNull();
			expect(root.querySelector(".colsdown-presets__status")?.classList.contains("is-error")).toBe(true);
		});

		it("keeps prior settings and commands when persistence fails", async () => {
			const existing = { id: "one", name: "Existing", layout: "colsdown" as const, widths: ["", ""] };
			const plugin = new FakePlugin([existing]);
			syncPresetCommands(plugin);
			const command = plugin.commands.get("insert-preset-one");
			plugin.failSave = true;
			const root = renderPresetSettings(document.createElement("div"), plugin);
			clickByText(root, "Delete");
			await vi.waitFor(() => expect(root.textContent).toContain("Could not save presets: disk full"));
			expect(plugin.settings.presets).toEqual([existing]);
			expect(plugin.commands.get("insert-preset-one")).toBe(command);
			expect(plugin.removed).toEqual([]);
		});

		it("restores focus after cancel, save, and delete", async () => {
			const plugin = new FakePlugin([
				{ id: "one", name: "First", layout: "colsdown", widths: ["", ""] },
				{ id: "two", name: "Second", layout: "stack", widths: ["", ""] },
			]);
			const container = document.body.appendChild(document.createElement("div"));
			try {
				const root = renderPresetSettings(container, plugin);
				clickByText(root, "Edit");
				clickByText(root, "Cancel");
				expect(document.activeElement?.getAttribute("aria-label")).toBe("Edit First preset");

				clickByText(root, "Edit");
				(root.querySelector('input[type="text"]') as HTMLInputElement).value = "Renamed";
				await submit(root);
				expect(document.activeElement?.getAttribute("aria-label")).toBe("Edit Renamed preset");

				clickByText(root, "Delete");
				await vi.waitFor(() => expect(plugin.settings.presets).toHaveLength(1));
				expect(document.activeElement?.getAttribute("aria-label")).toBe("Edit Second preset");

				clickByText(root, "Delete");
				await vi.waitFor(() => expect(plugin.settings.presets).toEqual([]));
				await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Add preset"));
			} finally {
				container.remove();
			}
		});
	});
});

describe("Insertion format", () => {
	interface Command { id: string; editorCallback: (editor: { replaceSelection: (source: string) => void }) => void }

	let syncPresetCommands: (plugin: unknown) => void;

	interface Settings { syntax: string; separator: string; presets: unknown[] }

	interface InsertionPlugin extends ObsidianMock.Plugin { settings: Settings; addCommands: () => void }

	let ColsdownPlugin: {
		new(): InsertionPlugin;
		normalizeSettings: (settings?: unknown) => Settings;
		CustomColumnsModal: new(app: unknown, separator: string, insert: (text: string) => void, syntax?: string) => ObsidianMock.Modal;
	};

		({ syncPresetCommands } = require("../src/presets.cjs") as { syncPresetCommands: (plugin: unknown) => void });
		ColsdownPlugin = require("../src/main.cjs") as typeof ColsdownPlugin;

	describe("existing insertion commands", () => {
		it("defaults new and existing settings without a preference to markers and respects an explicit block preference", () => {
			expect(ColsdownPlugin.normalizeSettings().syntax).toBe("markers");
			expect(ColsdownPlugin.normalizeSettings({ separator: "|||" }).syntax).toBe("markers");
			expect(ColsdownPlugin.normalizeSettings({ syntax: "invalid" }).syntax).toBe("markers");
			expect(ColsdownPlugin.normalizeSettings({ syntax: "fenced" }).syntax).toBe("fenced");
		});

		it("keeps the existing command IDs and uses the current insertion preference", () => {
			const plugin = new ColsdownPlugin();
			plugin.settings = ColsdownPlugin.normalizeSettings();
			plugin.addCommands();
			expect([...plugin.commands.keys()]).toEqual([
				"colsdown:insert-2-columns", "colsdown:insert-3-columns", "colsdown:insert-sidebar-30-70",
				"colsdown:insert-stack", "colsdown:insert-custom-columns",
			]);
			const replaceSelection = vi.fn();
			for (const [id, command] of plugin.commands) {
				if (id.endsWith("insert-custom-columns")) continue;
				(command as unknown as Command).editorCallback({ replaceSelection });
				expect(replaceSelection.mock.calls[replaceSelection.mock.calls.length - 1]?.[0]).toMatch(/^%% /);
				plugin.settings.syntax = "fenced";
				(command as unknown as Command).editorCallback({ replaceSelection });
				expect(replaceSelection.mock.calls[replaceSelection.mock.calls.length - 1]?.[0]).toMatch(/^```/);
				plugin.settings.syntax = "markers";
			}
		});

		it.each([undefined, "fenced"])("uses the selected format for custom width insertion (%s)", (syntax) => {
			const insert = vi.fn();
			const modal = new ColsdownPlugin.CustomColumnsModal({}, ":::", insert, syntax);
			modal.onOpen();
			const input = modal.contentEl.querySelector("input");
			if (!input) throw new Error("Custom width input was not rendered");
			input.value = "30%, 70%";
			modal.contentEl.querySelector("button")?.click();
			expect(insert).toHaveBeenCalledOnce();
			expect(insert.mock.calls[0]?.[0]).toMatch(syntax === "fenced" ? /^```colsdown/ : /^%% cols %%/);
			expect(modal.closed).toBe(true);
		});
	});

	describe("marker preset insertion", () => {
		it.each(["colsdown", "stack"])("uses current syntax preference with stable %s preset command IDs", (layout) => {
			const commands = new Map<string, Command>();
			const plugin = {
				settings: { syntax: "fenced", separator: "---", presets: [{ id: "stable", name: "Saved", layout, widths: ["30%", "70%"] }] },
				addCommand: (command: Command) => commands.set(command.id, command), removeCommand: vi.fn(),
			};
			syncPresetCommands(plugin);
			const command = commands.get("insert-preset-stable");
			const replaceSelection = vi.fn();
			command?.editorCallback({ replaceSelection });
			expect(replaceSelection.mock.calls[0]?.[0]).toMatch(/^```/);
			plugin.settings.syntax = "markers";
			syncPresetCommands(plugin);
			expect(commands.get("insert-preset-stable")).toBe(command);
			command?.editorCallback({ replaceSelection });
			const inserted = replaceSelection.mock.calls[1]?.[0] as string;
			expect(inserted).toContain(layout === "stack" ? "%% cols:stack %%" : "%% cols %%");
			expect(inserted).toContain(layout === "stack" ? "%% col %%" : "%% col:70 %%");
			expect(inserted).not.toMatch(/^%% cols(?::stack)? %%\n%% col/);
			expect(inserted).toContain("%% endcols %%");
			expect(inserted).not.toContain("---");
			expect(plugin.removeCommand).not.toHaveBeenCalled();
		});
	});
});

//#endregion

//#region Footnote Markdown semantics

describe("Code", () => {
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
});

describe("Html", () => {
	interface FootnoteApi {
		collectFootnoteDefinitions: (source: string) => Map<string, string>;
		hasFootnoteReferences: (markdown: string) => boolean;
	}

	const footnotes = require("../src/footnotes.cjs") as FootnoteApi;

	describe("footnote HTML boundaries", () => {
		it("uses backslash parity for escaped HTML comment openers", () => {
			const odd = "\\<!-- literal opener\nVisible[^odd].\n[^odd]: Kept.";
			const even = "\\\\<!-- real comment\nHidden[^even].\n[^even]: Hidden.\n-->";

			expect(footnotes.hasFootnoteReferences(odd)).toBe(true);
			expect(footnotes.collectFootnoteDefinitions(odd)).toEqual(new Map([
				["odd", "[^odd]: Kept."],
			]));
			expect(footnotes.hasFootnoteReferences(even)).toBe(false);
			expect(footnotes.collectFootnoteDefinitions(even)).toEqual(new Map());
		});

		it("ignores references and definitions inside literal-content HTML blocks", () => {
			const rawBlock = [
				"<pre>",
				"Hidden[^inside].",
				"[^inside]: Raw HTML, not Markdown.",
				"",
				"</pre>",
			].join("\n");
			const source = [
				rawBlock,
				"Outside[^outside].",
				"[^outside]: Real definition.",
			].join("\n");

			expect(footnotes.hasFootnoteReferences(rawBlock)).toBe(false);
			expect(footnotes.collectFootnoteDefinitions(rawBlock)).toEqual(new Map());
			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
			expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map([
				["outside", "[^outside]: Real definition."],
			]));
		});

		it("ends a literal-content block at any type-1 closing tag", () => {
			const source = [
				"<script>",
				"Hidden[^inside].",
				"</pre>",
				"Outside[^outside].",
				"[^outside]: Real definition.",
			].join("\n");

			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
			expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map([
				["outside", "[^outside]: Real definition."],
			]));
		});

		it("resumes Markdown scanning after blank-terminated HTML blocks", () => {
			for (const opening of ["<div>", "<widget data-kind=\"example\">"]) {
				const rawBlock = [
					opening,
					"Hidden[^inside].",
					"[^inside]: Raw HTML, not Markdown.",
					"",
				].join("\n");
				const source = [
					rawBlock,
					"Outside[^outside].",
					"[^outside]: Real definition.",
				].join("\n");

				expect(footnotes.hasFootnoteReferences(rawBlock)).toBe(false);
				expect(footnotes.collectFootnoteDefinitions(rawBlock)).toEqual(new Map());
				expect(footnotes.hasFootnoteReferences(source)).toBe(true);
				expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map([
					["outside", "[^outside]: Real definition."],
				]));
			}
		});

		it.each([
			["processing instruction", "<?target", "?>"],
			["declaration", "<!DOCTYPE html", ">"],
			["CDATA section", "<![CDATA[", "]]>"]
		])("keeps %s content opaque until its closing token", (_name, opening, closing) => {
			const source = [opening, "Hidden[^inside].", "[^inside]: Hidden.", closing].join("\n");

			expect(footnotes.hasFootnoteReferences(source)).toBe(false);
			expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map());
		});

		it("lets a type-7 HTML block follow a definition without a paragraph", () => {
			const source = "[^real]: Actual definition.\n<widget>\n[^fake]: Raw HTML.\n</widget>";
			expect(footnotes.collectFootnoteDefinitions(source).has("fake")).toBe(false);
		});

		it("keeps a paragraph open through an indented lazy continuation", () => {
			const source = "Paragraph\n    lazy continuation\n<widget>\nVisible[^good].\n[^good]: Good.";
			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
			expect(footnotes.collectFootnoteDefinitions(source).get("good")).toBe("[^good]: Good.");
			expect(footnotes.hasFootnoteReferences("Paragraph\n    lazy reference[^good]")).toBe(true);
		});

		it.each(["#", "#\tHeading", "* * *", "_ _ _", "Heading\n===", "Heading\n---"])("keeps HTML after a completed block opaque: %s", (block) => {
			const source = block + "\n<widget>\nHidden[^bad].\n[^bad]: HTML";
			expect(footnotes.hasFootnoteReferences(source)).toBe(false);
			expect(footnotes.collectFootnoteDefinitions(source).size).toBe(0);
		});

		it("keeps inline HTML and type-7 tags inside paragraphs Markdown-active", () => {
			expect(footnotes.hasFootnoteReferences("<span>Visible[^inline].</span>")).toBe(true);
			expect(footnotes.hasFootnoteReferences([
				"Paragraph continues",
				"<widget>",
				"Visible[^continuation].",
			].join("\n"))).toBe(true);
		});
	});
});

describe("Inline", () => {
	interface FootnoteApi {
		collectFootnoteDefinitions: (source: string) => Map<string, string>;
		hasFootnoteReferences: (markdown: string) => boolean;
	}

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

		it("does not open an HTML comment from a valid inline link title", () => {
			const source = [
				"[docs](url \"title <!--\") Visible[^note].",
				"-->",
			].join("\n");

			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		});

		it("keeps a comment opener local to valid inline link text", () => {
			const source = [
				"[<!--](url) Hidden[^note].",
				"-->",
			].join("\n");

			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		});

		it("does not open a comment from valid reference-definition metadata", () => {
			const source = [
				"[docs]: url \"title <!--\"",
				"Visible[^real].",
				"-->",
			].join("\n");

			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		});

		it("does not open a comment from a valid multiline reference-definition title", () => {
			const source = [
				"[docs]: url \"title <!--",
				"continued\"",
				"Visible[^real].",
				"-->",
				"",
				"[^real]: Real definition.",
			].join("\n");

			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		});

		it("leaves a malformed multiline title as prose", () => {
			const source = [
				"[docs]: url \"title <!--",
				"continued",
				"Visible[^real].",
				"-->",
			].join("\n");

			expect(footnotes.hasFootnoteReferences(source)).toBe(false);
		});

		it("does not open a comment from a valid raw inline HTML attribute", () => {
			const source = "<span title=\"<!--\">x</span> Visible[^note]. -->";

			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		});

		it.each([
			["attribute separator", "<span\n title=\"<!--\">x</span> Visible[^note].\n-->"],
			["quoted attribute value", "<span title=\"<!--\ncontinued\">x</span> Visible[^note].\n-->"],
		])("shields a comment opener in a valid multiline raw HTML %s", (_name, source) => {
			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		});

		it("leaves a malformed raw HTML tag comment-active", () => {
			const source = "<span title=\"<!--> Hidden[^note]. -->";

			expect(footnotes.hasFootnoteReferences(source)).toBe(false);
		});

		it.each([
			["HTML", "Text <!-- <span title=\"-->\"> Visible[^note]. -->"],
			["Obsidian", "%% <span title=\"%%\"> Visible[^note]. %%"],
		])("does not shield a comment closer inside tag-looking %s comment text", (_name, source) => {
			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		});

		it("keeps a leading HTML comment opaque as a raw HTML block", () => {
			const source = "<!-- <span title=\"-->\"> Hidden[^note]. -->";

			expect(footnotes.hasFootnoteReferences(source)).toBe(false);
		});

		it("shields successive multiline raw HTML tags until projection stabilizes", () => {
			const source = [
				"<span title=\"<!--",
				"one\">a</span> <span title=\"<!--",
				"two\">b</span> Visible[^note].",
			].join("\n");

			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		});

		it.each([
      ["a real HTML comment", "<!-- Hidden[^note]. -->", false],
      ["a real percent comment", "%% Hidden[^note]. %%", false],
      ["a malformed next attribute", '<span title="<!-- Hidden[^note]. -->', false],
      ["a later visible reference", '<span title="<!-- Hidden[^fake].\nend">x</span> Visible[^note].', true],
    ])("keeps %s authoritative after completing multiline attributes", (_name, suffix, expected) => {
      const source = `Text <span title="<!--\nend">x</span> ${suffix}`;
      expect(footnotes.hasFootnoteReferences(source)).toBe(expected);
    });

		it("stabilizes a long multiline raw HTML chain without growing the call stack", () => {
			const lines = ["Text <span title=\"<!--"];
			for (let index = 0; index < 2_999; index += 1) {
				lines.push(`${index}">x</span> <span title="<!--`);
			}
			lines.push("end\">x</span> Visible[^real]. -->");

			expect(footnotes.hasFootnoteReferences(lines.join("\n"))).toBe(true);
		}, 60_000);

		it("keeps definition syntax inside a multiline raw HTML attribute opaque", () => {
			const source = [
				"<span title=\"text",
				"[^fake]: attribute text",
				"end\">x</span>",
				"Visible[^real].",
				"",
				"[^real]: Real definition.",
			].join("\n");

			expect(footnotes.collectFootnoteDefinitions(source).has("fake")).toBe(false);
			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		});

		it.each([
			["processing instruction", "Text <?target value=\"%%\"?> Visible[^note]. %%"],
			["declaration", "Text <!TARGET value=\"%%\"> Visible[^note]. %%"],
			["CDATA section", "Text <![CDATA[%%]]> Visible[^note]. %%"],
		])("shields comment markers inside an inline HTML %s", (_name, source) => {
			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		});

		it("leaves an unterminated processing instruction as prose", () => {
			const source = "Text <?target %% Hidden[^note]. %%";

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
});

describe("Labels", () => {
	interface FootnoteApi {
		collectFootnoteDefinitions: (source: string) => Map<string, string>;
		hasFootnoteReferences: (source: string) => boolean;
	}

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
});

describe("Lazy", () => {
	interface FootnoteApi {
		collectFootnoteDefinitions: (source: string) => Map<string, string>;
		hasFootnoteReferences: (markdown: string) => boolean;
	}

	const footnotes = require("../src/footnotes.cjs") as FootnoteApi;

	describe("lazy container continuations", () => {
		it.each([
			"- Text `code\n[^fake]: literal\nend`",
			"> Text `code\n[^fake]: literal\nend`",
		])("keeps an omitted container prefix inside a multiline code span: %s", (source) => {
			expect(footnotes.hasFootnoteReferences(source)).toBe(false);
			expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map());
		});

		it.each([
			"- Text `code\n\nVisible[^real]",
			"> Text `code\n# Heading\nVisible[^real]",
			"- Text `code\n- Visible[^real]",
			"> Text `code\n```text\nHidden[^fake]\n```\nVisible[^real]",
		])("ends lazy container state at a Markdown block boundary: %s", (source) => {
			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		});
	});

	describe("native ordered-list comment boundaries", () => {
		it.each([["1", true], ["01", false], ["001", false]])("matches native Obsidian paragraph interruption for marker %s", (marker, active) => {
			expect(footnotes.hasFootnoteReferences(`Text <!--\n${marker}. Item\nVisible[^note]\n-->`)).toBe(active);
		});
	});

	describe("native zero-padded paragraph continuations", () => {
		it.each(["01", "001"])("keeps marker %s inside a complete code-span paragraph", (marker) => {
			const source = `Text \`code\n${marker}. Item\n[^fake]: literal\nend\``;
			expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map());
		});
	});

	describe("native empty-marker comment boundaries", () => {
		it.each(["+ ", "* ", "1. ", "1) ", "+\t", "1.\t", "+", "*", "1.", "1)"])("retains active references after empty marker %s", (marker) => {
			expect(footnotes.hasFootnoteReferences(`Text <!--\n${marker}\nVisible[^note]\n-->`)).toBe(true);
		});
	});
});

describe("Links", () => {
	interface FootnoteApi {
		hasFootnoteReferences: (markdown: string) => boolean;
		collectFootnoteDefinitions: (markdown: string) => Map<string, unknown>;
	}

	const footnotes = require("../src/footnotes.cjs") as FootnoteApi;

	describe("footnote references in links", () => {
		it("leaves a destination visible after an unescaped nested label bracket", () => {
			expect(footnotes.hasFootnoteReferences("[bad[label]: /url/[^note]")).toBe(true);
		});

		it.each([
			"[label]: /url/[^note]",
			"[label]: </url/[^note]>",
			"[label]:\n  /url/[^note]",
			"[label]:\n  </url/[^note]>",
			"[   ]: /url/[^note]",
			`[${"x".repeat(1_000)}]: /url/[^note]`,
			"[\u00a0]: /url/[^note]",
			"[\u2003]: /url/[^note]",
		])("leaves a named footnote visible in an invalid reference-definition destination: %s", (source) => {
			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		});

		it("keeps an invalid destination footnote visible with a local definition", () => {
			const source = "[label]: /url/[^note]\n\n[^note]: Local definition.";

			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		});

		it.each([
			"[label]: /url/[other]",
			"[label]: /url/\\[other\\]",
			"[label]: </url/[other]>",
		])("rejects every bracket form in a reference-definition destination: %s", (source) => {
			expect(footnotes.hasFootnoteReferences(`${source}\nVisible[^note].`)).toBe(true);
		});

		it("keeps an unresolved nested-label destination reference visible", () => {
			const source = "[docs][bad[label] Visible[^note].\n\n[bad[label]: /url";

			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		});

		it.each([
			"[\t]: /url/[^fake]",
			`[${"😀".repeat(999)}]: /url/[^fake]`,
			"[escaped\\[label]: /url/[^fake]",
			"[escaped\\]label]: /url/[^fake]",
		])("keeps invalid destination footnotes visible for native-valid tab, emoji, and escaped labels: %s", (source) => {
			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		});

		it.each([
			["full", "[docs][id <!--] Visible[^note]. -->\n\n[id <!--]: /url"],
			["collapsed", "[id <!--][] Visible[^note]. -->\n\n[id <!--]: /url"],
			["shortcut", "[id <!--] Visible[^note]. -->\n\n[id <!--]: /url"],
			["full with multiline definition", "[docs][id <!--] Visible[^note]. -->\n\n[id <!--]:\n  /url"],
			["full before definition", "[id %%]: /url\n\n[docs][id %%] Visible[^note]. %%"],
			["collapsed before definition", "[id %%]: /url\n\n[id %%][] Visible[^note]. %%"],
			["shortcut before definition", "[id %%]: /url\n\n[id %%] Visible[^note]. %%"],
		])("keeps comment syntax local to a resolved %s reference link", (_name, source) => {
			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		});

		it.each([
			"[docs][missing <!--] Visible[^note]. -->",
			"[missing %%][] Visible[^note]. %%",
			"[missing <!--] Visible[^note]. -->",
		])("keeps bracket-local comments bounded in unresolved reference syntax: %s", (source) => {
			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		});

		it("keeps unresolved reference-label footnotes visible", () => {
			expect(footnotes.hasFootnoteReferences("[docs][missing[^real]]")).toBe(true);
		});

		it("keeps footnotes in a resolved reference link's visible label active", () => {
			const source = "[docs[^real]][id]\n\n[id]: /url";

			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		});

		it.each([
			["valid email", "<foo%%@example.com> Visible[^note]. %%", true],
			["native domain", "<foo%%@bad_domain> Visible[^note]. %%", true],
			["malformed email", "<foo%%@> Hidden[^note]. %%", false],
			["active comment", "Text %% <foo%%@example.com> Visible[^note]. %%", true],
		])("handles %s email autolink comment precedence", (_name, source, expected) => {
			expect(footnotes.hasFootnoteReferences(source)).toBe(expected);
		});

		it.each([
			"<span title=\"[\">x</span>](url/[^note])",
			"<span title=\"\n[\">x</span>](url/[^note])",
			"`[`x](url/[^note])",
		])("does not pair a label opener hidden in raw metadata or code: %s", (source) => {
			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		});

		it.each([
			"[docs](https://host/[^version])",
			"[docs](https://host/(release)/[^version])",
			"[docs](https://host/escaped\\)/[^version])",
			"[docs](<https://host/[^version]>)",
			"[docs](https://host/[^version] \"release title[^title]\")",
			"<https://host/[^version]>",
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

		it.each([
			"[outer [inner](u) more](dest/[^fake])",
			"[outer [inner](u)\nmore](dest/[^fake])",
		])("keeps an outer link destination opaque around nested link syntax: %s", (source) => {
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
		])("leaves invalid destination footnotes visible after block boundaries: %s", (source) => {
			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
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
});

describe("Math", () => {
	interface FootnoteApi {
		collectFootnoteDefinitions: (source: string) => Map<string, string>;
		hasFootnoteReferences: (markdown: string) => boolean;
	}

	const footnotes = require("../src/footnotes.cjs") as FootnoteApi;

	describe("inline math footnote shielding", () => {
		it("keeps references inside complete inline math opaque", () => {
			expect(footnotes.hasFootnoteReferences("$x[^fake]$")).toBe(false);
		});

		it("shields a comment opener inside math without hiding following references", () => {
			expect(footnotes.hasFootnoteReferences("$<!--$ Visible[^note] -->")).toBe(true);
		});

		it("keeps multiline math content opaque within one paragraph", () => {
			const source = "$x\n[^fake]: literal\nend$ Visible[^note].";
			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
			expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map());
		});

		it.each([
			"$ x[^real] $",
			"$x[^real] $",
			"\\$x[^real]$",
			"$x[^real]\\$",
			"$x[^real]",
			"$x[^real]$2",
		])("leaves invalid or literal delimiters Markdown-active: %s", (source) => {
			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		});

		it.each([
			"$2[^fake]$",
			"$x[^fake]$a",
			"$x[^fake]$$",
		])("matches native digit and adjacent-dollar delimiter behavior: %s", (source) => {
			expect(footnotes.hasFootnoteReferences(source)).toBe(false);
		});

		it.each([
			"Text $$x[^fake]$$",
			"Text $$ x[^fake] $$",
			"Text $$x[^fake] $$",
			"Text $$x\n[^fake]: literal\nend$$",
			"Text \\$$x[^fake]$$",
		])("keeps paragraph-level double-dollar math opaque: %s", (source) => {
			expect(footnotes.hasFootnoteReferences(source)).toBe(false);
			expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map());
		});

		it("keeps references after paragraph-level double-dollar math active", () => {
			expect(footnotes.hasFootnoteReferences("Text $$x[^fake]$$ After[^note].")).toBe(true);
		});

		it.each([
			"- Math $x\n[^fake]: literal\nend$",
			"> Math $x\n[^fake]: literal\nend$",
		])("preserves a lazy container across multiline math: %s", (source) => {
			expect(footnotes.hasFootnoteReferences(source)).toBe(false);
			expect(footnotes.collectFootnoteDefinitions(source)).toEqual(new Map());
		});

		it.each([
			"$x\n\nVisible[^real]\nend$",
			"$x\n# Heading\nVisible[^real]\nend$",
			"- $x\n- Visible[^real]\nend$",
			"> $x\n```text\nHidden[^fake]\n```\nVisible[^real]\nend$",
		])("stops multiline math at a block boundary: %s", (source) => {
			expect(footnotes.hasFootnoteReferences(source)).toBe(true);
		});

		it("keeps earlier comments, code, links, and HTML metadata authoritative", () => {
			expect(footnotes.hasFootnoteReferences("Text <!-- $-->$ Visible[^real]")).toBe(true);
			expect(footnotes.hasFootnoteReferences("`$<!--$` Visible[^real] -->")).toBe(true);
			expect(footnotes.hasFootnoteReferences("[docs](https://host/$<!--$) Visible[^real] -->")).toBe(true);
			expect(footnotes.hasFootnoteReferences("<span data-value=\"$<!--$\">x</span> Visible[^real] -->")).toBe(true);
		});
	});
});

//#endregion

//#region Release metadata

describe("Release contracts", () => {
	const readJson = (path: string): Record<string, unknown> => (
		JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
	);

	describe("release metadata", () => {
		it("keeps package, lockfile, manifest, and versions in sync", () => {
			const packageJson = readJson("package.json");
			const lock = readJson("package-lock.json");
			const manifest = readJson("manifest.json");
			const versions = readJson("versions.json");
			const packages = lock.packages as Record<string, Record<string, unknown>>;

			expect(manifest).toMatchObject({
				id: "colsdown",
				name: "Colsdown",
				version: packageJson.version,
				minAppVersion: "1.12.7",
				isDesktopOnly: false,
			});
			expect(packageJson.version).toBe(manifest.version);
			expect(lock.version).toBe(manifest.version);
			expect(packages[""]?.version).toBe(manifest.version);
			expect(versions[String(manifest.version)]).toBe(manifest.minAppVersion);
		});

		it("documents the exact release asset contract", () => {
			const workflow = readFileSync(".github/workflows/release.yml", "utf8");
			expect(workflow).toContain("main.js manifest.json styles.css");
			expect(workflow).toContain("gh release upload");
			expect(workflow).toContain("--draft=false --latest");
		});

		it("keeps hover colors and backgrounds scoped to interactive controls", () => {
			const css = readFileSync("styles.css", "utf8");
			const blocks = css.split("}");
			for (const block of blocks) {
				if (/:hover|background(?:-color)?\s*:/u.test(block)) {
					expect(block).toMatch(/\.colsdown-resize-(?:handle|grip)|button\.colsdown-add-column/u);
				}
			}
		});
	});
});

//#endregion
