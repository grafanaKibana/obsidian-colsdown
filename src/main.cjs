const {
  MarkdownRenderer,
  MarkdownRenderChild,
  Modal,
  Plugin,
  PluginSettingTab,
  Setting,
  setIcon,
} = require("obsidian");

const layoutApi = require("./layout.cjs");
const { CANONICAL_SEPARATOR, isValidSeparator, parseLayout, columnTracks, layoutTemplate, validateWidths } = layoutApi;
const { normalizePresets, syncPresetCommands, renderPresetSettings } = require("./presets.cjs");
const { attachResizers } = require("./resize.cjs");
const { prepareSourceEdit, commitAddedColumn, NEW_COLUMN_PLACEHOLDER } = require("./source-edits.cjs");
const MAX_NESTING_DEPTH = 6;
const DEFAULT_SETTINGS = Object.freeze({
  separator: CANONICAL_SEPARATOR,
  gapPx: 16,
  minColumnWidthPx: 250,
  responsiveBreakpointPx: 600,
  dividerStyle: "none",
  dividerWidthPx: 1,
});
const DIVIDER_STYLES = ["none", "solid", "dashed", "dotted"];

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function normalizeSettings(value = {}) {
  if (!value || typeof value !== "object") value = {};
  const dividerStyle = DIVIDER_STYLES.includes(value.dividerStyle)
    ? value.dividerStyle
    : DEFAULT_SETTINGS.dividerStyle;
  return {
    separator: isValidSeparator(value.separator) ? value.separator.trim() : DEFAULT_SETTINGS.separator,
    gapPx: clampNumber(value.gapPx, DEFAULT_SETTINGS.gapPx, 0, 96),
    minColumnWidthPx: clampNumber(value.minColumnWidthPx, DEFAULT_SETTINGS.minColumnWidthPx, 80, 1200),
    responsiveBreakpointPx: clampNumber(value.responsiveBreakpointPx, DEFAULT_SETTINGS.responsiveBreakpointPx, 200, 2000),
    dividerStyle,
    dividerWidthPx: clampNumber(value.dividerWidthPx, DEFAULT_SETTINGS.dividerWidthPx, 1, 8),
    presets: normalizePresets(value.presets),
  };
}

function styleText(settings) {
  return `.layout-columns-root {\n`
    + `  --layout-gap: ${settings.gapPx}px;\n`
    + `  --layout-min-width: ${settings.minColumnWidthPx}px;\n`
    + `  --layout-divider-style: ${settings.dividerStyle};\n`
    + `  --layout-divider-width: ${settings.dividerWidthPx}px;\n`
    + `}\n`
    + `@container layout-columns (max-width: ${settings.responsiveBreakpointPx}px) {\n`
    + `  .layout-columns.layout-explicit { grid-template-columns: minmax(0, 1fr) !important; }\n`
    + `  .layout-columns.layout-explicit > .layout-item + .layout-item::before { inset-inline: 0; inset-block: auto; inset-block-start: calc((var(--layout-gap) + var(--layout-divider-width)) / -2); border-inline-start: 0; border-block-start: var(--layout-divider-width) var(--layout-divider-style) var(--background-modifier-border); }\n`
    + `}\n`;
}

function nestingDepth(element) {
  let depth = 0;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent.classList && parent.classList.contains("layout-columns-root")) depth += 1;
  }
  return depth;
}

function createElement(parent, tag, className) {
  const element = parent.ownerDocument.createElement(tag);
  if (className) element.className = className;
  parent.appendChild(element);
  return element;
}

function showFallback(parent, source) {
  if (typeof parent.replaceChildren === "function") parent.replaceChildren();
  else parent.textContent = "";
  const fallback = createElement(parent, "pre", "layout-render-fallback");
  fallback.textContent = source;
  return fallback;
}

function attachColumnControls(plugin, source, element, layout, context, child, separator) {
  let currentSource = source;
  let disposed = false;
  let disposeResizers = () => {};
  const refreshResizers = () => {
    disposeResizers();
    disposeResizers = attachResizers({ app: plugin.app, source: currentSource, element, layout, context,
      separator, child,
      onSourceChange: (updated) => { currentSource = updated; } });
  };
  refreshResizers();
  const button = createElement(element, "button", "colsdown-add-column clickable-icon interactive-child");
  button.type = "button";
  button.setAttribute("aria-label", "Add column");
  button.title = "Add auto-sized column";
  setIcon(button, "plus");
  const status = createElement(element, "div", "colsdown-add-status");
  status.setAttribute("role", "status");

  // The native Live Preview toolbar can arrive after the code block renderer.
  const widget = element.closest(".cm-embed-block");
  let observer;
  const placeButton = () => {
    if (!widget || widget.querySelector(".layout-columns-root") !== element) return false;
    const edit = widget.querySelector(":scope > .embed-actions > .edit-block-button, :scope > .edit-block-button");
    if (!edit) return false;
    button.classList.toggle("embed-action", edit.parentElement.classList.contains("embed-actions"));
    button.classList.toggle("colsdown-add-column--legacy", edit.parentElement === widget);
    if (button.parentElement !== edit.parentElement || button.nextElementSibling !== edit) edit.before(button);
    return true;
  };
  if (widget && widget.querySelector(".layout-columns-root") === element) {
    placeButton();
    observer = new element.ownerDocument.defaultView.MutationObserver(placeButton);
    observer.observe(widget, { childList: true, subtree: true });
  }
  for (const type of ["pointerdown", "mousedown", "keydown"]) {
    child.registerDomEvent(button, type, (event) => event.stopPropagation());
  }
  child.registerDomEvent(button, "click", async (event) => {
    event.stopPropagation();
    if (disposed || button.disabled) return;
    button.disabled = true;
    status.classList.remove("is-error");
    status.textContent = "Adding column…";
    try {
      const prepared = await prepareSourceEdit(plugin.app, context, element, currentSource, separator);
      if (disposed) return;
      const saved = await commitAddedColumn(plugin.app, prepared);
      if (disposed) return;
      currentSource = saved.source;
      const item = createElement(layout, "div", "layout-item");
      const content = createElement(item, "div", "layout-content");
      createElement(content, "p").textContent = NEW_COLUMN_PLACEHOLDER;
      layout.style.gridTemplateColumns = columnTracks(parseLayout(currentSource, "row", separator).items);
      refreshResizers();
      status.textContent = "Column added.";
    } catch (error) {
      if (!disposed) {
        status.classList.add("is-error");
        status.textContent = `Column was not added. ${error instanceof Error ? error.message : "Reopen the note and try again."}`;
      }
    } finally {
      button.disabled = false;
    }
  });
  const dispose = () => {
    disposed = true;
    observer?.disconnect();
    disposeResizers();
    button.remove();
    status.remove();
  };
  child.register(dispose);
  return dispose;
}

async function renderLayout(plugin, source, element, context, direction) {
  const depth = nestingDepth(element);
  element.classList.add("layout-columns-root");
  if (depth >= MAX_NESTING_DEPTH) {
    showFallback(element, source);
    return;
  }
  const parsed = parseLayout(source, direction, plugin.settings.separator);
  const layout = createElement(
    element,
    "div",
    `layout-layout ${direction === "row" ? "layout-columns" : "layout-stack"}`,
  );
  const explicit = parsed.items.some((item) => item.width.kind !== "auto");
  if (explicit) layout.classList.add("layout-explicit");
  if (direction === "row") layout.style.gridTemplateColumns = columnTracks(parsed.items);

  for (const item of parsed.items) {
    const itemElement = createElement(layout, "div", "layout-item");
    const content = createElement(itemElement, "div", "layout-content");
    const child = new MarkdownRenderChild(content);
    context.addChild(child);
    try {
      await MarkdownRenderer.render(plugin.app, item.markdown, content, context.sourcePath, child);
    } catch (error) {
      console.error("Colsdown failed to render an item.", error);
      showFallback(content, item.markdown);
    }
  }
  if (direction === "row" && context.sourcePath) {
    const child = new MarkdownRenderChild(element);
    context.addChild(child);
    const dispose = attachColumnControls(plugin, source, element, layout, context, child, parsed.separator);
    // Plugin disable must also dispose controllers in still-visible notes.
    plugin.activeResizers ||= new Set();
    plugin.activeResizers.add(dispose);
    child.register(() => plugin.activeResizers.delete(dispose));
  }
}

class CustomColumnsModal extends Modal {
  constructor(app, separator, insert) {
    super(app);
    this.separator = separator;
    this.insert = insert;
  }

  onOpen() {
    this.contentEl.replaceChildren();
    const title = createElement(this.contentEl, "h2");
    title.textContent = "Insert custom columns";
    const label = createElement(this.contentEl, "label");
    label.textContent = "Widths (comma-separated)";
    const input = createElement(label, "input");
    input.type = "text";
    input.placeholder = "30%, 70%";
    const error = createElement(this.contentEl, "p", "colsdown-input-error");
    error.setAttribute("role", "alert");
    error.id = `colsdown-width-error-${crypto.randomUUID()}`;
    input.setAttribute("aria-describedby", error.id);
    const submit = () => {
      const result = validateWidths(input.value);
      error.textContent = result.error || "";
      input.setAttribute("aria-invalid", String(Boolean(result.error)));
      if (result.error) { input.focus(); return; }
      this.insert(layoutTemplate("colsdown", result.widths, this.separator));
      this.close();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
    });
    const button = createElement(this.contentEl, "button");
    button.textContent = "Insert";
    button.className = "mod-cta";
    button.addEventListener("click", submit);
    input.focus();
  }
}

class ColsdownSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    if (typeof containerEl.empty === "function") containerEl.empty();
    else containerEl.replaceChildren();

    new Setting(containerEl).setName("Separator").addText((text) => text
      .setValue(this.plugin.settings.separator)
      .onChange(async (value) => {
        if (isValidSeparator(value)) await this.plugin.updateSettings({ separator: value });
      }));
    this.addSlider("Gap", "gapPx", 0, 96);
    this.addSlider("Minimum column width", "minColumnWidthPx", 80, 1200);
    this.addSlider("Responsive breakpoint", "responsiveBreakpointPx", 200, 2000);
    new Setting(containerEl).setName("Divider").addDropdown((dropdown) => dropdown
      .addOptions({ none: "None", solid: "Solid", dashed: "Dashed", dotted: "Dotted" })
      .setValue(this.plugin.settings.dividerStyle)
      .onChange(async (value) => this.plugin.updateSettings({ dividerStyle: value })));
    this.addSlider("Divider width", "dividerWidthPx", 1, 8);
    renderPresetSettings(containerEl, this.plugin);
  }

  addSlider(name, key, min, max) {
    new Setting(this.containerEl).setName(name).addSlider((slider) => slider
      .setLimits(min, max, 1)
      .setValue(this.plugin.settings[key])
      .setDynamicTooltip()
      .onChange(async (value) => this.plugin.updateSettings({ [key]: value })));
  }
}

class ColsdownPlugin extends Plugin {
  async onload() {
    this.activeResizers = new Set();
    this.settingsQueue = Promise.resolve();
    this.settings = normalizeSettings(await this.loadData());
    this.styleElement = document.createElement("style");
    this.styleElement.id = "colsdown-settings";
    document.head.appendChild(this.styleElement);
    this.applyStyle();

    this.registerMarkdownCodeBlockProcessor("colsdown", (source, element, context) => (
      renderLayout(this, source, element, context, "row")
    ));
    this.registerMarkdownCodeBlockProcessor("stack", (source, element, context) => (
      renderLayout(this, source, element, context, "column")
    ));
    this.addSettingTab(new ColsdownSettingTab(this.app, this));
    this.addCommands();
    syncPresetCommands(this);
  }

  onunload() {
    for (const dispose of this.activeResizers || []) dispose();
    this.activeResizers?.clear();
    if (this.styleElement) this.styleElement.remove();
  }

  applyStyle() {
    this.styleElement.textContent = styleText(this.settings);
  }

  updateSettings(patch) {
    const save = (this.settingsQueue || Promise.resolve()).then(async () => {
      const next = normalizeSettings({ ...this.settings, ...patch });
      await this.saveData(next);
      this.settings = next;
      this.applyStyle();
      syncPresetCommands(this);
    });
    // Keep later saves usable after a failure; the caller still receives the rejection.
    this.settingsQueue = save.then(() => undefined, () => undefined);
    return save;
  }

  addCommands() {
    const insert = (id, name, language, widths) => this.addCommand({
      id,
      name,
      editorCallback: (editor) => editor.replaceSelection(
        layoutTemplate(language, widths, this.settings.separator),
      ),
    });
    insert("insert-2-columns", "Insert 2 columns", "colsdown", ["", ""]);
    insert("insert-3-columns", "Insert 3 columns", "colsdown", ["", "", ""]);
    insert("insert-sidebar-30-70", "Insert 30/70 sidebar", "colsdown", ["30%", "70%"]);
    insert("insert-stack", "Insert stack", "stack", ["", ""]);
    this.addCommand({
      id: "insert-custom-columns",
      name: "Insert custom columns",
      editorCallback: (editor) => new CustomColumnsModal(
        this.app,
        this.settings.separator,
        (source) => editor.replaceSelection(source),
      ).open(),
    });
  }
}

Object.assign(ColsdownPlugin, {
  ...layoutApi,
  DEFAULT_SETTINGS,
  MAX_NESTING_DEPTH,
  normalizeSettings,
  renderLayout,
  styleText,
  CustomColumnsModal,
  ColsdownSettingTab,
});

module.exports = ColsdownPlugin;
