const { ButtonComponent, Setting, TextComponent, setIcon } = require("obsidian");
const { layoutTemplate, validateWidths } = require("./layout.cjs");

const commandState = new WeakMap();
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

function uuid() {
  return crypto.randomUUID();
}

function validName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  return name.length > 0 && name.length <= 80 && !/[\p{C}\u2028\u2029]/u.test(name) ? name : null;
}

function normalizePresets(value) {
  if (!Array.isArray(value)) return [];
  const presets = [];
  const names = new Set();
  const ids = new Set();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const name = validName(candidate.name);
    const layout = candidate.layout === "stack" ? "stack" : candidate.layout === "colsdown" ? "colsdown" : null;
    if (!name || !layout || names.has(name.toLowerCase())) continue;
    let widths;
    if (layout === "stack") {
      if (!Array.isArray(candidate.widths) || candidate.widths.length < 2 || candidate.widths.length > 20) continue;
      widths = candidate.widths.map(() => "");
    } else {
      const validated = validateWidths(candidate.widths);
      if (validated.error) continue;
      widths = validated.widths;
    }
    let id = typeof candidate.id === "string" && SAFE_ID.test(candidate.id) ? candidate.id : uuid();
    while (ids.has(id)) id = uuid();
    names.add(name.toLowerCase());
    ids.add(id);
    presets.push({ id, name, layout, widths });
  }
  return presets;
}

function syncPresetCommands(plugin) {
  const previous = commandState.get(plugin) || new Map();
  const next = new Map();
  const presets = normalizePresets(plugin.settings && plugin.settings.presets);
  for (const preset of presets) {
    const rawId = `insert-preset-${preset.id}`;
    const name = `Insert preset: ${preset.name}`;
    next.set(rawId, name);
    if (previous.get(rawId) === name) continue;
    if (previous.has(rawId)) plugin.removeCommand(rawId);
    const command = {
      id: rawId,
      name,
      editorCallback(editor) {
        const current = normalizePresets(plugin.settings && plugin.settings.presets)
          .find((item) => item.id === preset.id);
        if (!current) return;
        editor.replaceSelection(layoutTemplate(
          current.layout,
          current.widths,
          plugin.settings && plugin.settings.separator,
        ));
      },
    };
    plugin.addCommand(command);
  }
  for (const rawId of previous.keys()) {
    if (!next.has(rawId)) plugin.removeCommand(rawId);
  }
  commandState.set(plugin, next);
}

function element(parent, tag, className, text) {
  const child = parent.ownerDocument.createElement(tag);
  if (className) child.className = className;
  if (text !== undefined) child.textContent = text;
  parent.appendChild(child);
  return child;
}

function renderPresetSettings(container, plugin) {
  const root = element(container, "section", "colsdown-presets");
  const heading = new Setting(root).setName("Presets").setHeading().setClass("colsdown-presets__heading");
  heading.nameEl.id = `colsdown-presets-${uuid()}`;
  root.setAttribute("aria-labelledby", heading.nameEl.id);
  const status = element(root, "div", "colsdown-presets__status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const list = element(root, "div", "colsdown-presets__list");
  let addButton;
  const addSetting = new Setting(root)
    .setName("Custom presets")
    .setDesc("Save reusable column and stack layouts.")
    .setClass("colsdown-presets__add-row")
    .addButton((button) => {
      addButton = button.setButtonText("Add preset").setClass("colsdown-presets__add");
    });
  let editingId = null;
  let savedId = null;

  const presets = () => normalizePresets(plugin.settings && plugin.settings.presets);
  const restoreFocus = (presetId) => {
    if (presetId) {
      const row = Array.from(list.querySelectorAll(".colsdown-presets__item"))
        .find((item) => item.dataset.presetId === presetId);
      const edit = row && row.querySelector("button");
      if (edit) {
        edit.focus();
        return;
      }
    }
    addButton.buttonEl.focus();
  };
  const setStatus = (message, error = false) => {
    status.textContent = message;
    status.classList.toggle("is-error", error);
  };
  const persist = async (next, focusId, updatedId = null) => {
    setStatus("Saving…");
    root.setAttribute("aria-busy", "true");
    const controls = Array.from(root.querySelectorAll("button, input"), (control) => [control, control.disabled]);
    for (const [control] of controls) control.disabled = true;
    const submit = root.querySelector('button[type="submit"]');
    if (submit) submit.textContent = "Saving…";
    let saved = false;
    try {
      await plugin.updateSettings({ presets: next });
      editingId = null;
      savedId = updatedId;
      setStatus(updatedId ? "Preset saved." : "Preset deleted.");
      draw();
      saved = true;
    } catch (error) {
      setStatus(error instanceof Error ? `Could not save presets: ${error.message}` : "Could not save presets.", true);
    } finally {
      root.removeAttribute("aria-busy");
      for (const [control, disabled] of controls) control.disabled = disabled;
      if (submit) submit.textContent = "Save";
    }
    if (saved) restoreFocus(focusId);
    return saved;
  };

  const openForm = (preset) => {
    editingId = preset ? preset.id : "";
    savedId = null;
    setStatus("");
    draw();
  };

  const drawForm = (preset) => {
    const form = element(list, "form", "colsdown-presets__form");
    const title = new Setting(form)
      .setName(preset ? "Edit preset" : "Add preset")
      .setHeading()
      .setClass("colsdown-presets__form-title");
    const error = element(form, "div", "colsdown-presets__form-error");
    error.setAttribute("role", "alert");
    error.id = `colsdown-preset-error-${uuid()}`;
    form.setAttribute("aria-describedby", error.id);

    let name;
    new Setting(form).setName("Name").setClass("colsdown-presets__field").addText((text) => {
      name = text.setValue(preset ? preset.name : "");
      name.inputEl.maxLength = 80;
      name.inputEl.required = true;
      name.inputEl.setAttribute("aria-label", "Preset name");
    });

    let layout = preset ? preset.layout : "colsdown";
    let draftWidths = preset ? preset.widths.slice() : ["", ""];
    const layoutSetting = new Setting(form).setName("Layout").setClass("colsdown-presets__layout");
    const choices = layoutSetting.controlEl;
    choices.classList.add("colsdown-presets__choices");
    choices.setAttribute("role", "tablist");
    choices.setAttribute("aria-label", "Layout");
    const tabId = `colsdown-layout-${uuid()}`;
    const parts = element(form, "div", "colsdown-presets__parts");
    parts.id = `${tabId}-panel`;
    parts.setAttribute("role", "tabpanel");
    const hint = element(form, "p", "colsdown-presets__hint setting-item-description");
    hint.id = `colsdown-width-hint-${uuid()}`;
    parts.setAttribute("aria-describedby", hint.id);
    const tabs = new Map();

    function readWidths() {
      if (layout === "colsdown") draftWidths = Array.from(parts.querySelectorAll("input"), (input) => input.value);
    }
    function focusPart(index) {
      const target = parts.children[index]?.querySelector(layout === "colsdown" ? "input" : "button:not(:disabled)");
      (target || addPart.buttonEl).focus();
    }
    function updateTabs() {
      for (const [value, tab] of tabs) {
        const selected = value === layout;
        tab.buttonEl.setAttribute("aria-selected", String(selected));
        tab.buttonEl.tabIndex = selected ? 0 : -1;
        if (selected) tab.setCta();
        else tab.removeCta();
      }
      const active = tabs.get(layout);
      parts.setAttribute("aria-labelledby", active.buttonEl.id);
    }
    function chooseLayout(value, focus = false) {
      readWidths();
      layout = value;
      error.textContent = "";
      updateTabs();
      drawParts();
      if (focus) tabs.get(value).buttonEl.focus();
    }
    const tabValues = ["colsdown", "stack"];
    for (const [index, value] of tabValues.entries()) {
      const tab = new ButtonComponent(choices)
        .setButtonText(value === "colsdown" ? "Columns" : "Stack")
        .setClass("colsdown-presets__choice");
      tab.buttonEl.type = "button";
      tab.buttonEl.id = `${tabId}-${value}`;
      tab.buttonEl.setAttribute("role", "tab");
      tab.buttonEl.setAttribute("aria-controls", parts.id);
      tab.onClick(() => chooseLayout(value));
      tab.buttonEl.addEventListener("keydown", (event) => {
        let next = null;
        if (event.key === "ArrowLeft") next = tabValues[(index + tabValues.length - 1) % tabValues.length];
        if (event.key === "ArrowRight") next = tabValues[(index + 1) % tabValues.length];
        if (event.key === "Home") next = tabValues[0];
        if (event.key === "End") next = tabValues[tabValues.length - 1];
        if (!next) return;
        event.preventDefault();
        chooseLayout(next, true);
      });
      tabs.set(value, tab);
    }

    const footer = element(form, "div", "colsdown-presets__footer");
    const addPart = new ButtonComponent(footer).setClass("colsdown-presets__add-part");
    addPart.buttonEl.type = "button";
    addPart.onClick(() => {
      readWidths();
      draftWidths.push("");
      error.textContent = "";
      drawParts();
      focusPart(draftWidths.length - 1);
    });
    const actions = element(footer, "div", "colsdown-presets__actions");
    const save = new ButtonComponent(actions).setButtonText("Save").setCta();
    save.buttonEl.type = "submit";
    const cancel = new ButtonComponent(actions).setButtonText("Cancel");
    cancel.buttonEl.type = "button";
    cancel.onClick(() => {
      const focusId = preset && preset.id;
      editingId = null;
      setStatus("");
      draw();
      restoreFocus(focusId);
    });

    function drawParts() {
      parts.replaceChildren();
      const stack = layout === "stack";
      parts.classList.toggle("is-stack", stack);
      hint.textContent = stack ? "Sections flow from top to bottom." : "Auto shares the available space. Use %, fr, or a number for a percentage.";
      addPart.setButtonText(stack ? "Add section" : "Add column");
      const addIcon = addPart.buttonEl.ownerDocument.createElement("span");
      addIcon.className = "colsdown-presets__button-icon";
      setIcon(addIcon, "plus");
      addPart.buttonEl.prepend(addIcon);
      addPart.buttonEl.setAttribute("aria-label", stack ? "Add section" : "Add column");
      addPart.setDisabled(draftWidths.length >= 20);
      draftWidths.forEach((width, index) => {
        const part = new Setting(parts)
          .setName(`${stack ? "Section" : "Column"} ${index + 1}`)
          .setClass("colsdown-presets__part");
        if (!stack) {
          const input = new TextComponent(part.controlEl)
            .setValue(width)
            .setPlaceholder("Auto")
            .onChange(() => { error.textContent = ""; });
          input.inputEl.setAttribute("aria-label", `Column ${index + 1} width`);
          input.inputEl.setAttribute("aria-describedby", `${hint.id} ${error.id}`);
          input.inputEl.spellcheck = false;
          input.inputEl.classList.add("colsdown-presets__width");
        }
        const remove = new ButtonComponent(part.controlEl)
          .setClass("colsdown-presets__remove-part")
          .setDisabled(draftWidths.length <= 2);
        remove.buttonEl.type = "button";
        remove.setTooltip(draftWidths.length <= 2
          ? "Layouts need at least two sections"
          : `Remove ${stack ? "section" : "column"} ${index + 1}`);
        remove.buttonEl.setAttribute("aria-label", `Remove ${stack ? "section" : "column"} ${index + 1}`);
        remove.setIcon("minus");
        remove.onClick(() => {
          readWidths();
          draftWidths.splice(index, 1);
          error.textContent = "";
          drawParts();
          focusPart(Math.min(index, draftWidths.length - 1));
        });
      });
    }
    updateTabs();
    drawParts();
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (root.getAttribute("aria-busy") === "true") return;
      const normalizedName = validName(name.getValue());
      if (!normalizedName) {
        error.textContent = "Enter a name between 1 and 80 characters.";
        return;
      }
      const duplicate = presets().some((item) => item.id !== (preset && preset.id)
        && item.name.toLowerCase() === normalizedName.toLowerCase());
      if (duplicate) {
        error.textContent = "Preset names must be unique.";
        return;
      }
      let widths;
      readWidths();
      if (layout === "stack") {
        widths = draftWidths.map(() => "");
      } else {
        const validated = validateWidths(draftWidths.map((width) => {
          const value = width.trim();
          return /^\d+(?:\.\d+)?$/.test(value) ? `${value}%` : value;
        }));
        if (validated.error) {
          error.textContent = validated.error;
          return;
        }
        widths = validated.widths;
      }
      let id = preset ? preset.id : uuid();
      const current = presets();
      while (!preset && current.some((item) => item.id === id)) id = uuid();
      const nextPreset = {
        id,
        name: normalizedName,
        layout,
        widths,
      };
      const next = preset
        ? current.map((item) => item.id === preset.id ? nextPreset : item)
        : [...current, nextPreset];
      await persist(next, id, id);
    });
    title.nameEl.tabIndex = -1;
    name.inputEl.focus();
  };

  function draw() {
    list.replaceChildren();
    const current = presets();
    if (current.length === 0 && editingId === null) {
      new Setting(list).setName("No presets yet.").setClass("colsdown-presets__empty");
    }
    for (const preset of current) {
      const row = new Setting(list)
        .setName(preset.name)
        .setDesc(preset.layout === "stack"
          ? `${preset.widths.length} sections`
          : preset.widths.map((width) => width || "auto").join(", "))
        .setClass("colsdown-presets__item");
      row.settingEl.dataset.presetId = preset.id;
      if (editingId === preset.id) {
        drawForm(preset);
        row.settingEl.remove();
        continue;
      }
      if (savedId === preset.id) {
        const saved = element(row.nameEl, "span", "colsdown-presets__saved");
        saved.title = "Saved";
        saved.setAttribute("aria-hidden", "true");
        setIcon(saved, "check");
      }
      row.addButton((button) => {
        button.setButtonText("Edit");
        button.buttonEl.setAttribute("aria-label", `Edit ${preset.name} preset`);
        button.onClick(() => openForm(preset));
      });
      row.addButton((button) => {
        button.setButtonText("Delete").setWarning();
        button.buttonEl.setAttribute("aria-label", `Delete ${preset.name} preset`);
        button.onClick(async () => {
          const next = current.filter((item) => item.id !== preset.id);
          const index = current.findIndex((item) => item.id === preset.id);
          const focusId = next[Math.min(index, next.length - 1)]?.id || null;
          await persist(next, focusId);
        });
      });
    }
    if (editingId === "") drawForm(null);
    addSetting.settingEl.hidden = editingId !== null;
  }

  addButton.onClick(() => openForm(null));
  draw();
  return root;
}

module.exports = { normalizePresets, syncPresetCommands, renderPresetSettings };
