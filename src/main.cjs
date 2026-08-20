const {
  MarkdownRenderer,
  MarkdownRenderChild,
  Modal,
  Plugin,
  PluginSettingTab,
  Setting,
} = require("obsidian");

const CANONICAL_SEPARATOR = ":::";
const MAX_SEPARATOR_LENGTH = 64;
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

function isValidSeparator(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= MAX_SEPARATOR_LENGTH
    && value.trim().length > 0
    && !/[\p{C}\u2028\u2029`~]/u.test(value);
}

function normalizeSettings(value = {}) {
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
  };
}

function splitLines(source) {
  if (source === "") return [""];
  const lines = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "\n" && source[index] !== "\r") continue;
    const end = source[index] === "\r" && source[index + 1] === "\n" ? index + 2 : index + 1;
    lines.push(source.slice(start, end));
    start = end;
    index = end - 1;
  }
  if (start < source.length) lines.push(source.slice(start));
  return lines;
}

function lineBody(line) {
  return line.replace(/(?:\r\n|\r|\n)$/, "");
}

function fenceChange(line, openFence) {
  const body = lineBody(line);
  const indentation = /^( {0,3})/.exec(body)[0].length;
  const rest = body.slice(indentation);
  const character = rest[0];
  if (openFence) {
    if (character !== openFence.character) return openFence;
    let length = 0;
    while (rest[length] === character) length += 1;
    return length >= openFence.length && rest.slice(length).trim() === "" ? null : openFence;
  }
  if (character !== "`" && character !== "~") return null;
  let length = 0;
  while (rest[length] === character) length += 1;
  if (length < 3 || (character === "`" && rest.slice(length).includes("`"))) return null;
  return { character, length };
}

function normalizeWidth(metadata) {
  const value = metadata.trim();
  const percent = /^(?:\d+(?:\.\d*)?|\.\d+)%$/.test(value) ? Number(value.slice(0, -1)) : NaN;
  if (Number.isFinite(percent) && percent >= 1 && percent <= 100) {
    return { kind: "percent", value: percent };
  }
  const fraction = /^(?:\d+(?:\.\d*)?|\.\d+)fr$/i.test(value) ? Number(value.slice(0, -2)) : NaN;
  if (Number.isFinite(fraction) && fraction > 0) {
    return { kind: "fraction", value: fraction };
  }
  return { kind: "auto" };
}

function markerMetadata(line, separator) {
  const trimmed = lineBody(line).trim();
  if (!trimmed.startsWith(separator)) return null;
  const remainder = trimmed.slice(separator.length);
  if (remainder !== "" && !/^\s/.test(remainder)) return null;
  return remainder.trim();
}

function parseLayout(source, direction = "row", configuredSeparator = CANONICAL_SEPARATOR) {
  const separator = isValidSeparator(configuredSeparator) ? configuredSeparator.trim() : CANONICAL_SEPARATOR;
  const candidates = separator === CANONICAL_SEPARATOR
    ? [CANONICAL_SEPARATOR]
    : [CANONICAL_SEPARATOR, separator];
  const lines = splitLines(source);
  const prefix = [];
  const items = [];
  let current = [];
  let currentWidth = { kind: "auto" };
  let fence = null;
  let lockedSeparator = null;

  for (const line of lines) {
    if (!fence) {
      const available = lockedSeparator ? [lockedSeparator] : candidates;
      let marker = null;
      for (const candidate of available) {
        const metadata = markerMetadata(line, candidate);
        if (metadata !== null) {
          marker = { separator: candidate, metadata };
          break;
        }
      }
      if (marker) {
        if (!lockedSeparator) {
          lockedSeparator = marker.separator;
          if (prefix.join("").trim() !== "") {
            items.push({ width: { kind: "auto" }, markdown: prefix.join("") });
            current = [];
          } else {
            current = prefix.slice();
          }
        } else {
          items.push({ width: currentWidth, markdown: current.join("") });
          current = [];
        }
        currentWidth = normalizeWidth(marker.metadata);
        continue;
      }
    }

    fence = fenceChange(line, fence);
    if (lockedSeparator) current.push(line);
    else prefix.push(line);
  }

  if (!lockedSeparator) {
    return { direction, items: [{ width: { kind: "auto" }, markdown: source }] };
  }
  items.push({ width: currentWidth, markdown: current.join("") });
  return { direction, items };
}

function columnTracks(items) {
  if (items.every((item) => item.width.kind === "auto")) {
    return "repeat(auto-fit, minmax(var(--layout-min-width), 1fr))";
  }
  if (items.every((item) => item.width.kind === "percent")) {
    return items.map((item) => `${item.width.value}fr`).join(" ");
  }
  return items.map((item) => {
    if (item.width.kind === "percent") return `${item.width.value}%`;
    if (item.width.kind === "fraction") return `${item.width.value}fr`;
    return "minmax(0, 1fr)";
  }).join(" ");
}

function widthSource(width) {
  const normalized = typeof width === "object" ? width : normalizeWidth(String(width || ""));
  if (normalized.kind === "percent") return `${normalized.value}%`;
  if (normalized.kind === "fraction") return `${normalized.value}fr`;
  return "";
}

function layoutTemplate(language, widths, separator = CANONICAL_SEPARATOR) {
  const marker = isValidSeparator(separator) ? separator.trim() : CANONICAL_SEPARATOR;
  const labels = language === "stack" ? "Section" : "Column";
  const itemWidths = widths.length ? widths : ["", ""];
  const sources = itemWidths.map(widthSource);
  const percentageTotal = sources.every((value) => value.endsWith("%"))
    ? sources.reduce((sum, value) => sum + Number(value.slice(0, -1)), 0)
    : 0;
  const body = itemWidths.map((width, index) => {
    const suffix = sources[index];
    const inferredFirst = suffix === "" || suffix.toLowerCase() === "1fr" || percentageTotal === 100;
    const boundary = language === "colsdown" && index === 0 && inferredFirst
      ? ""
      : `${marker}${suffix ? ` ${suffix}` : ""}\n`;
    return `${boundary}${labels} ${index + 1}`;
  }).join("\n\n");
  return `\`\`\`${language}\n${body}\n\`\`\``;
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
    + `  .layout-columns.layout-explicit > .layout-item + .layout-item { border-inline-start: 0; border-block-start: var(--layout-divider-width) var(--layout-divider-style) var(--background-modifier-border); }\n`
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
    const submit = () => {
      const widths = input.value.split(",").map((value) => value.trim());
      this.insert(layoutTemplate("colsdown", widths, this.separator));
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
  }

  onunload() {
    if (this.styleElement) this.styleElement.remove();
  }

  applyStyle() {
    this.styleElement.textContent = styleText(this.settings);
  }

  async updateSettings(patch) {
    this.settings = normalizeSettings({ ...this.settings, ...patch });
    await this.saveData(this.settings);
    this.applyStyle();
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
  CANONICAL_SEPARATOR,
  DEFAULT_SETTINGS,
  MAX_SEPARATOR_LENGTH,
  MAX_NESTING_DEPTH,
  columnTracks,
  fenceChange,
  isValidSeparator,
  layoutTemplate,
  normalizeSettings,
  normalizeWidth,
  parseLayout,
  renderLayout,
  splitLines,
  styleText,
});

module.exports = ColsdownPlugin;
