const {
  MarkdownRenderChild,
  Modal,
  Plugin,
  PluginSettingTab,
  Setting,
  setIcon,
} = require("obsidian");

const layoutApi = require("./layout.cjs");
const { CANONICAL_SEPARATOR, isValidSeparator, parseLayoutSource, columnTracks, layoutTemplate, validateWidths } = layoutApi;
const { layoutItemOffsets, layoutItemRanges, registerMarkerReading, renderMarkerMarkdown } = require("./marker-rendering.cjs");
const { registerMarkerEditor } = require("./marker-editor.cjs");
const { normalizePresets, syncPresetCommands, renderPresetSettings } = require("./presets.cjs");
const { attachResizers } = require("./resize.cjs");
const { prepareSourceEdit, commitAddedColumn, NEW_COLUMN_PLACEHOLDER,
  normalizeRenderedBody } = require("./source-edits.cjs");
const { collectFootnoteDefinitions, hasFootnoteReferences, hydrateFootnotes, mapFootnoteLayouts,
  readFootnoteDefinitions } = require("./footnotes.cjs");
const MAX_NESTING_DEPTH = 6;
const DEFAULT_SETTINGS = Object.freeze({
  syntax: "markers",
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
    syntax: value.syntax === "fenced" ? "fenced" : DEFAULT_SETTINGS.syntax,
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
    + `.layout-content.colsdown-footnote-staging { visibility: hidden; height: 0; overflow: hidden; pointer-events: none; }\n`
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

function layoutTracks(items, nested) {
  return nested && items.every((item) => item.width.kind === "auto")
    ? items.map(() => "minmax(0, 1fr)").join(" ") : columnTracks(items);
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

async function refreshFootnoteLayouts(plugin, file) {
  const path = file?.path;
  if (typeof path !== "string" || !plugin.activeFootnoteRenders?.size) return;
  const records = [...plugin.activeFootnoteRenders]
    .filter((record) => record.sourcePath === path);
  await Promise.all(records.map(async (record) => {
    try {
      await record.refresh();
    } catch (error) {
      console.error("Colsdown could not refresh a layout after footnotes changed.", error);
    }
  }));
}

function markStaging(content) {
  content.setAttribute("aria-hidden", "true");
  content.classList.add("colsdown-footnote-staging");
}

function revealStaging(content) {
  content.removeAttribute("aria-hidden");
  content.classList.remove("colsdown-footnote-staging");
}

function removeStaged(owner, staged, activeStages) {
  for (const entry of staged.reverse()) {
    activeStages.delete(entry);
    owner.removeChild(entry.child);
    entry.content.remove();
  }
}

async function renderItemChanges(plugin, context, owner, states, definitions, revisionValid, activeStages) {
  const changes = states.flatMap((state) => {
    if (state.itemElement.querySelector(".colsdown-inline-editor")) return [];
    const markdown = state.hasReferences && definitions
      ? hydrateFootnotes(state.originalMarkdown, definitions)
      : state.originalMarkdown;
    return state.content && markdown === state.renderedMarkdown ? [] : [{ state, markdown }];
  });
  if (changes.length === 0) return { status: "unchanged" };

  const staged = [];
  try {
    for (const change of changes) {
      const content = createElement(change.state.itemElement, "div", "layout-content");
      markStaging(content);
      const child = owner.addChild(new MarkdownRenderChild(content));
      const entry = { ...change, content, child };
      staged.push(entry);
      activeStages.add(entry);
      await renderMarkerMarkdown(plugin, change.markdown, content, { ...context, layoutOriginalMarkdown: change.state.originalMarkdown,
        layoutItemOffset: change.state.sourceOffset, layoutSource: change.state.layoutSource }, child, renderLayout);
      if (!revisionValid()) {
        removeStaged(owner, staged, activeStages);
        return { status: "abandoned" };
      }
    }
  } catch (error) {
    removeStaged(owner, staged, activeStages);
    return { status: "failed", error };
  }

  if (!revisionValid()) {
    removeStaged(owner, staged, activeStages);
    return { status: "abandoned" };
  }
  const replaced = staged.map((entry) => ({ content: entry.state.content, child: entry.state.child }));
  for (const entry of staged) {
    activeStages.delete(entry);
    if (entry.state.itemElement.querySelector(".colsdown-inline-editor")) {
      owner.removeChild(entry.child);
      entry.content.remove();
      continue;
    }
    revealStaging(entry.content);
    if (entry.state.content) entry.state.content.replaceWith(entry.content);
    entry.state.content = entry.content;
    entry.state.child = entry.child;
    entry.state.renderedMarkdown = entry.markdown;
  }
  for (const previous of replaced) {
    if (previous.child && !states.some((state) => state.child === previous.child)) owner.removeChild(previous.child);
  }
  return { status: "rendered" };
}

function attachColumnControls(plugin, source, element, layout, context, child, separator, directRecord = null) {
  let currentSource = source;
  let disposed = false;
  let disposeResizers = () => {};
  const onSourceChange = (updated, saved) => {
    currentSource = updated;
    if (context.layoutHandle) {
      context.layoutHandle.source = updated;
      context.layoutHandle.location = saved.location;
      context.layoutHandle.snapshot = saved.snapshot;
    }
    const edit = { ...saved, layoutMappings: mapFootnoteLayouts(saved.previousSnapshot, saved.snapshot) };
    for (const record of plugin.activeFootnoteRenders ?? []) {
      if (record.sourcePath === context.sourcePath) record.sourceEdited(updated, edit, record === directRecord);
    }
  };
  const refreshResizers = () => {
    disposeResizers();
    disposeResizers = attachResizers({ app: plugin.app, source: currentSource, element, layout, context,
      separator, child,
      onSourceChange });
  };
  refreshResizers();
  const syncSource = (updated) => {
    currentSource = updated;
    refreshResizers();
  };
  if (directRecord) directRecord.syncControlSource = syncSource;
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
      onSourceChange(currentSource, saved);
      const item = createElement(layout, "div", "layout-item");
      const content = createElement(item, "div", "layout-content");
      createElement(content, "p").textContent = NEW_COLUMN_PLACEHOLDER;
      layout.style.gridTemplateColumns = layoutTracks(parseLayoutSource(currentSource, "row", separator, context.layoutHandle?.syntax).items,
        layout.classList.contains("layout-nested"));
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
    if (directRecord?.syncControlSource === syncSource) directRecord.syncControlSource = null;
    observer?.disconnect();
    disposeResizers();
    button.remove();
    status.remove();
  };
  child.register(dispose);
  return dispose;
}

async function renderLayout(plugin, source, element, context, direction) {
  context = { ...context, renderSectionInfo: context.renderSectionInfo ?? context.getSectionInfo?.(element) };
  const depth = nestingDepth(element);
  element.classList.add("layout-columns-root");
  if (depth >= MAX_NESTING_DEPTH) {
    showFallback(element, source);
    return;
  }
  let disposed = false;
  const owner = new MarkdownRenderChild(element);
  context.addChild(owner);
  let revision = 0;
  let record;
  const activeStages = new Set();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    revision += 1;
    if (record) plugin.activeFootnoteRenders?.delete(record);
    for (const entry of activeStages) {
      entry.child.unload();
      entry.content.remove();
    }
    activeStages.clear();
  };
  owner.register(dispose);

  const parsed = parseLayoutSource(source, direction, plugin.settings.separator, context.layoutHandle?.syntax);
  const needsDefinitions = parsed.items.some((item) => hasFootnoteReferences(item.markdown));
  const layout = createElement(
    element,
    "div",
    `layout-layout ${direction === "row" ? "layout-columns" : "layout-stack"}`,
  );
  const nestedAuto = depth > 0 && direction === "row" && parsed.items.every((item) => item.width.kind === "auto");
  const explicit = nestedAuto || parsed.items.some((item) => item.width.kind !== "auto");
  if (explicit) layout.classList.add("layout-explicit");
  if (depth > 0) layout.classList.add("layout-nested");
  if (direction === "row") layout.style.gridTemplateColumns = layoutTracks(parsed.items, depth > 0);

  const itemOffsets = layoutItemOffsets(source, parsed, context.layoutHandle?.syntax);
  const states = parsed.items.map((item, index) => {
    const sourceOffset = itemOffsets[index];
    const rawRange = parsed.itemRanges?.[index];
    const markdown = rawRange ? source.slice(rawRange.from, rawRange.to) : item.markdown;
    const itemElement = createElement(layout, "div", "layout-item");
    return {
      child: null,
      content: null,
      hasReferences: hasFootnoteReferences(markdown),
      itemElement,
      originalMarkdown: markdown,
      sourceOffset,
      layoutSource: source,
      renderedMarkdown: null,
    };
  });

  if (context.inlineEditing?.registerLayout && context.layoutHandle) {
    const unregister = context.inlineEditing.registerLayout({ context, onUpdate: (previousSnapshot, snapshot, candidate) => {
      record?.sourceEdited(candidate.body, { previousSource: context.layoutHandle.source,
        previousLocation: context.layoutHandle.location, location: { lineStart: candidate.lineStart, lineEnd: candidate.lineEnd },
        snapshot, previousSnapshot, layoutMappings: mapFootnoteLayouts(previousSnapshot, snapshot) }, true);
    } });
    if (typeof unregister === "function") owner.register(unregister);
  }
  const registerEditableItems = () => {
    const base = context.layoutHandle?.bodyStart ?? context.layoutHandle?.start;
    if (!context.inlineEditing?.registerItem || !Number.isInteger(base)) return;
    const liveSource = context.layoutHandle.source;
    const liveParsed = parseLayoutSource(liveSource, direction, plugin.settings.separator, context.layoutHandle.syntax);
    if (liveParsed.items.length !== states.length) return;
    const ranges = layoutItemRanges(liveSource, liveParsed, context.layoutHandle.syntax);
    states.forEach((state, index) => {
      const range = ranges[index];
      if (!range || range.from < 0 || range.to < range.from) return;
      const item = { element: state.itemElement,
        from: base + range.from, to: base + range.to,
        renderPreview: async (markdown, from) => {
          if (disposed) return;
          const previewRevision = state.previewRevision = (state.previewRevision ?? 0) + 1;
          const content = element.ownerDocument.createElement("div");
          content.className = "layout-content";
          markStaging(content);
          state.itemElement.append(content);
          const child = owner.addChild(new MarkdownRenderChild(content));
          const snapshot = await context.layoutHandle.getSnapshot?.() ?? context.layoutHandle.snapshot;
          const hydrated = typeof snapshot === "string" ? hydrateFootnotes(markdown, collectFootnoteDefinitions(snapshot)) : markdown;
          try {
            await renderMarkerMarkdown(plugin, hydrated, content, { ...context,
              layoutOriginalMarkdown: markdown,
              layoutItemOffset: from - (context.layoutHandle.bodyStart ?? context.layoutHandle.start),
              layoutSource: context.layoutHandle.source }, child, renderLayout);
            if (disposed || previewRevision !== state.previewRevision || state.itemElement.querySelector(".colsdown-inline-editor")) {
              owner.removeChild(child);
              content.remove();
              return;
            }
            revealStaging(content);
            const previous = state.child;
            const previousContent = state.content ?? state.itemElement.querySelector(":scope > .layout-content");
            if (previousContent) previousContent.replaceWith(content);
            else state.itemElement.append(content);
            state.child = child;
            state.content = content;
            state.originalMarkdown = markdown;
            state.renderedMarkdown = hydrated;
            state.hasReferences = hasFootnoteReferences(markdown);
            if (previous) owner.removeChild(previous);
          } catch (error) {
            owner.removeChild(child);
            content.remove();
            console.error("Colsdown failed to refresh an edited column.", error);
          }
        } };
      const unregister = context.inlineEditing.registerItem(item);
      if (typeof unregister === "function") owner.register(unregister);
      if (liveSource !== source) void item.renderPreview(liveSource.slice(range.from, range.to), base + range.from);
    });
  };

  if (!needsDefinitions) {
    for (const state of states) {
      const content = createElement(state.itemElement, "div", "layout-content");
      const child = owner.addChild(new MarkdownRenderChild(content));
      state.content = content;
      state.child = child;
      try {
        await renderMarkerMarkdown(plugin, state.originalMarkdown, content, { ...context, layoutItemOffset: state.sourceOffset, layoutSource: source }, child, renderLayout);
        if (disposed) return;
      } catch (error) {
        if (disposed) return;
        owner.removeChild(child);
        state.child = null;
        console.error("Colsdown failed to render an item.", error);
        showFallback(content, state.originalMarkdown);
      }
    }
    registerEditableItems();
    if (direction === "row" && context.sourcePath) {
      const disposeControls = attachColumnControls(plugin, source, element, layout, context, owner, parsed.separator);
      plugin.activeResizers ||= new Set();
      plugin.activeResizers.add(disposeControls);
      owner.register(() => plugin.activeResizers.delete(disposeControls));
    }
    return;
  }

  let initialized = false;
  let currentSource = source;
  let validatedLocation = null;
  let queue = Promise.resolve();
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const attempt = async (requestedRevision, initial) => {
    if (disposed || requestedRevision !== revision) return;
    const snapshot = await readFootnoteDefinitions(
      plugin.app,
      context,
      element,
      currentSource,
      direction,
      validatedLocation,
    );
    if (snapshot && validatedLocation === null) validatedLocation = snapshot.location;
    if (disposed || requestedRevision !== revision) return;
    if (snapshot === null && !initial) return;
    if (snapshot) {
      context.renderSectionInfo = { text: snapshot.snapshot, ...snapshot.location };
      if (context.layoutHandle) context.layoutHandle.snapshot = snapshot.snapshot;
    }
    const definitions = snapshot?.definitions ?? null;
    const result = await renderItemChanges(
      plugin,
      context,
      owner,
      states,
      definitions,
      () => !disposed && requestedRevision === revision,
      activeStages,
    );
    if (result.status === "failed" && !disposed && requestedRevision === revision) {
      console.error("Colsdown failed to render an item.", result.error);
      if (initial) {
        for (const state of states) {
          const content = createElement(state.itemElement, "div", "layout-content");
          showFallback(content, state.originalMarkdown);
          state.content = content;
        }
      }
    }
  };
  const enqueue = (requestedRevision, initial = false) => {
    const task = queue.then(() => attempt(requestedRevision, initial));
    queue = task.catch(() => undefined);
    return task;
  };

  if (context.sourcePath) {
    plugin.activeFootnoteRenders ||= new Set();
    record = {
      sourcePath: context.sourcePath,
      refresh: () => {
        const requestedRevision = ++revision;
        if (!initialized) return ready.then(() => queue);
        return enqueue(requestedRevision);
      },
      sourceEdited: (updated, saved, direct = false) => {
        if (disposed) return;
        const language = direction === "row" ? "colsdown" : "stack";
        const sameLocation = (left, right) => left?.lineStart === right?.lineStart && left?.lineEnd === right?.lineEnd;
        let mapping = validatedLocation && saved.layoutMappings?.find((candidate) => (
          candidate.language === language
          && (candidate.syntax ?? "fenced") === (context.layoutHandle?.syntax ?? "fenced")
          && sameLocation(candidate.previousLocation, validatedLocation)
          && normalizeRenderedBody(candidate.previousSource) === normalizeRenderedBody(currentSource)
        ));
        if (!mapping && direct && sameLocation(saved.previousLocation,
          validatedLocation ?? saved.previousLocation)
          && normalizeRenderedBody(saved.previousSource) === normalizeRenderedBody(currentSource)) {
          mapping = { source: updated, location: saved.location };
        }
        if (!mapping) return;
        currentSource = mapping.source;
        validatedLocation = mapping.location;
        context.renderSectionInfo = { text: saved.snapshot, ...mapping.location };
        if (context.layoutHandle) {
          context.layoutHandle.source = currentSource;
          context.layoutHandle.location = mapping.location;
          context.layoutHandle.snapshot = saved.snapshot;
        }
        if (!direct) record.syncControlSource?.(currentSource);
        const mappedParsed = parseLayoutSource(currentSource, direction, plugin.settings.separator, context.layoutHandle?.syntax);
        const mappedItems = mappedParsed.items;
        if (mappedItems.length === states.length) {
          const mappedOffsets = layoutItemOffsets(currentSource, mappedParsed, context.layoutHandle?.syntax);
          mappedItems.forEach((item, index) => {
            const rawRange = mappedParsed.itemRanges?.[index];
            const markdown = rawRange ? currentSource.slice(rawRange.from, rawRange.to) : item.markdown;
            states[index].layoutSource = currentSource;
            states[index].sourceOffset = mappedOffsets[index];
            states[index].originalMarkdown = markdown;
            states[index].hasReferences = hasFootnoteReferences(markdown);
          });
        }
        revision += 1;
        void enqueue(revision);
      },
      dispose: () => owner.unload(),
    };
    plugin.activeFootnoteRenders.add(record);
  }

  const initial = attempt(0, true);
  queue = initial.catch(() => undefined);
  await initial;
  initialized = true;
  const latest = revision > 0 && !disposed ? enqueue(revision) : initial;
  resolveReady();
  await latest;
  if (disposed) return;

  if (!states.some((state) => state.content)) {
    for (const state of states) {
      const content = createElement(state.itemElement, "div", "layout-content");
      showFallback(content, state.originalMarkdown);
      state.content = content;
    }
  }
  registerEditableItems();
  if (direction === "row" && context.sourcePath) {
    const disposeControls = attachColumnControls(plugin, currentSource, element, layout, context, owner, parsed.separator, record);
    // Plugin disable must also dispose controllers in still-visible notes.
    plugin.activeResizers ||= new Set();
    plugin.activeResizers.add(disposeControls);
    owner.register(() => plugin.activeResizers.delete(disposeControls));
  }
}

class CustomColumnsModal extends Modal {
  constructor(app, separator, insert, syntax = "markers") {
    super(app);
    this.separator = separator;
    this.syntax = syntax;
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
      this.insert(layoutTemplate("colsdown", result.widths, this.separator, this.syntax));
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

    new Setting(containerEl).setName("Insertion format").addDropdown((dropdown) => dropdown
      .addOptions({ markers: "Markers", fenced: "Code block" })
      .setValue(this.plugin.settings.syntax)
      .onChange(async (syntax) => this.plugin.updateSettings({ syntax })));
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
    this.activeFootnoteRenders = new Set();
    this.settingsQueue = Promise.resolve();
    this.settings = normalizeSettings(await this.loadData());
    this.styleElement = document.createElement("style");
    this.styleElement.id = "colsdown-settings";
    document.head.appendChild(this.styleElement);
    this.applyStyle();

    this.registerEvent(this.app.vault.on("modify", (file) => refreshFootnoteLayouts(this, file)));

    this.registerMarkdownCodeBlockProcessor("colsdown", (source, element, context) => (
      renderLayout(this, source, element, context, "row")
    ));
    this.registerMarkdownCodeBlockProcessor("stack", (source, element, context) => (
      renderLayout(this, source, element, context, "column")
    ));
    registerMarkerReading(this, renderLayout);
    registerMarkerEditor(this, renderLayout);
    this.addSettingTab(new ColsdownSettingTab(this.app, this));
    this.addCommands();
    syncPresetCommands(this);
  }

  onunload() {
    for (const dispose of this.activeResizers || []) dispose();
    this.activeResizers?.clear();
    for (const record of [...this.activeFootnoteRenders || []]) record.dispose();
    this.activeFootnoteRenders?.clear();
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
        layoutTemplate(language, widths, this.settings.separator, this.settings.syntax),
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
        this.settings.syntax,
      ).open(),
    });
  }
}

Object.assign(ColsdownPlugin, {
  ...layoutApi,
  DEFAULT_SETTINGS,
  MAX_NESTING_DEPTH,
  normalizeSettings,
  refreshFootnoteLayouts,
  renderLayout,
  styleText,
  CustomColumnsModal,
  ColsdownSettingTab,
});

module.exports = ColsdownPlugin;
