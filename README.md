# Colsdown

Responsive Markdown columns and stacks for Obsidian. Works in Reading View and Live Preview, using your theme’s styles.

![Colsdown 1.1.0: edit directly inside columns and navigate between them and the note with arrow keys.](docs/assets/colsdown-v1-release.png)

- **Write in place:** in Live Preview, edit one column while its neighbors stay rendered.
- **Keep moving:** arrows navigate between columns and into or out of the layout; Cmd/Ctrl+A selects the active column’s text.
- **Choose your syntax:** compact comment markers or fenced code blocks, with the same layout features.
- **Shape your layout:** resize, add columns, nest layouts, create stacks, and reuse presets. Columns adapt to narrow panes.

[Watch the quick demo](docs/assets/colsdown-demo.gif)

## Get started

Run **Colsdown: Insert 2 columns** from the command palette, then replace the placeholders:

```markdown
%% cols %%
Left content

%% col %%
Right content
%% endcols %%
```

Content after `cols` is the first column; each `col` starts another. Keep markers on their own lines. Click a column or enter with the arrows to edit in Live Preview. Use Source Mode to change layout markers or fences.

- **Widths:** use `%% col:60 %%` for 60% or `%% col:2fr %%` for a fractional width. Omit the width for automatic sizing; the first column shares the remaining space. An explicit first `col` can set its width or keep it empty.
- **Resize:** drag a divider or focus it and use arrow keys. Widths save on release; Escape cancels.
- **Add:** select **+** to append a column.
- **Stack:** start with `%% cols:stack %%` for vertical sections.

Columns can contain ordinary Markdown, footnotes, code blocks, and nested layouts. They stack automatically in narrow panes.

## Prefer code blocks?

Choose **Settings → Colsdown → Insertion format → Code block**. The same commands and presets will insert fenced layouts:

````markdown
```colsdown
Left content

::: 60%
Right content
```
````

Use `stack` instead of `colsdown` for vertical sections. Make an outer fence longer than any code fences nested inside it.

Settings also provide spacing, dividers, responsive sizing, and named presets. See the [demo vault](demo/Colsdown%20test%20matrix.md) for more examples.

## Install

Install with [BRAT](https://github.com/TfTHacker/obsidian42-brat) using `grafanaKibana/obsidian-colsdown`, or copy `main.js`, `manifest.json`, and `styles.css` from the same [release](https://github.com/grafanaKibana/obsidian-colsdown/releases) into `<Vault>/.obsidian/plugins/colsdown/`. Reload Obsidian and enable **Colsdown**.

Runs locally on desktop and mobile, with no network requests, telemetry, or account.

[Report an issue](https://github.com/grafanaKibana/obsidian-colsdown/issues) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)
