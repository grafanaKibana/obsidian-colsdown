import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import Module from "node:module";
import * as ObsidianMock from "./obsidian.mock";

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

const require = createRequire(import.meta.url);
type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleInternals = Module as unknown as { _load: ModuleLoader };
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => (
	request === "obsidian"
		? ObsidianMock
		: originalLoad.call(Module, request, parent, isMain)
);
let presetsApi: PresetsApi;
try {
	presetsApi = require("../src/presets.cjs") as PresetsApi;
} finally {
	moduleInternals._load = originalLoad;
}
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
