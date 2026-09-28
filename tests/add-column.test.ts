import { createRequire } from "node:module";
import Module from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ObsidianMock from "./obsidian.mock";

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
const require = createRequire(import.meta.url);
type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleInternals = Module as unknown as { _load: ModuleLoader };
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => (
  request === "obsidian" ? ObsidianMock : originalLoad.call(Module, request, parent, isMain)
);
let api: ColsdownApi;
try { api = require("../src/main.cjs") as ColsdownApi; }
finally { moduleInternals._load = originalLoad; }

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
