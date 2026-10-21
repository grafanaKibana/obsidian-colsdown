import { createRequire } from "node:module";
import Module from "node:module";
import { describe, expect, it, vi } from "vitest";
import * as ObsidianMock from "./obsidian.mock";

interface Command { id: string; editorCallback: (editor: { replaceSelection: (source: string) => void }) => void }
const require = createRequire(import.meta.url);
type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const internals = Module as unknown as { _load: Loader };
const original = internals._load;
internals._load = (request, parent, isMain) => request === "obsidian"
	? ObsidianMock : original.call(Module, request, parent, isMain);
let syncPresetCommands: (plugin: unknown) => void;
interface Settings { syntax: string; separator: string; presets: unknown[] }
interface InsertionPlugin extends ObsidianMock.Plugin { settings: Settings; addCommands: () => void }
let ColsdownPlugin: {
	new(): InsertionPlugin;
	normalizeSettings: (settings?: unknown) => Settings;
	CustomColumnsModal: new(app: unknown, separator: string, insert: (text: string) => void, syntax?: string) => ObsidianMock.Modal;
};
try {
	({ syncPresetCommands } = require("../src/presets.cjs") as { syncPresetCommands: (plugin: unknown) => void });
	ColsdownPlugin = require("../src/main.cjs") as typeof ColsdownPlugin;
} finally { internals._load = original; }

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
