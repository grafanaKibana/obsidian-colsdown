# Community listing copy

## Short description / About proposal

Responsive Markdown columns and stacks with direct in-column editing, seamless keyboard navigation, and draggable widths. Use compact markers or fenced code blocks in Reading View and Live Preview.

## Overview — ready to paste

![Colsdown 1.1.0: drag to resize, nest your layout, and save your presets.](https://raw.githubusercontent.com/grafanaKibana/obsidian-colsdown/main/docs/assets/colsdown-v1-release.png)

**Colsdown** brings responsive Markdown columns and vertical stacks to Obsidian, in both Reading View and Live Preview. Your content uses Obsidian’s native Markdown renderer and your theme’s styles.

**New in 1.1.0: write directly inside your layout.** In Live Preview, edit one column while its neighbors stay rendered. Arrow keys move through its text, between columns, and back into the surrounding note. Navigate the whole note without clicking or pressing Escape. Cmd/Ctrl+A selects the active column’s text.

### Start with compact markers

Run **Colsdown: Insert 2 columns**, then replace the placeholders:

```markdown
%% cols %%
Left content

%% col %%
Right content
%% endcols %%
```

The first column begins immediately after `cols`; each `col` starts another. Keep markers on their own lines. Markers are the default for insertion commands. Prefer fenced layouts? Change **Settings → Colsdown → Insertion format → Code block**. Existing `colsdown` and `stack` fences still work, including direct editing and keyboard navigation.

### Build the layout you need

- Drag dividers to resize columns, or focus a divider and use arrow keys. Widths are saved in the note.
- Add columns with **+**, nest layouts, or use `%% cols:stack %%` for vertical sections.
- Set widths such as `%% col:60 %%` or `%% col:2fr %%`, or let columns size automatically.
- Save named presets and adjust spacing, dividers, and responsive sizing in settings.

Columns stack automatically in narrow panes. Ordinary Markdown, footnotes, and code blocks work inside them. Use Source Mode to edit layout markers or fences.

Runs locally on desktop and mobile, with no network requests, telemetry, or account.

[Watch the demo](https://raw.githubusercontent.com/grafanaKibana/obsidian-colsdown/main/docs/assets/colsdown-demo.gif) · [Repository and setup](https://github.com/grafanaKibana/obsidian-colsdown) · [Releases](https://github.com/grafanaKibana/obsidian-colsdown/releases)
