<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/grafanaKibana/obsidian-colsdown/HEAD/docs/assets/product-captures/hero-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/grafanaKibana/obsidian-colsdown/HEAD/docs/assets/product-captures/hero.png">
  <img src="https://raw.githubusercontent.com/grafanaKibana/obsidian-colsdown/HEAD/docs/assets/product-captures/hero.png" alt="Colsdown: Markdown columns and nested layouts in Obsidian.">
</picture>

<p align="center">
Responsive Markdown columns and stacks for Obsidian. Works in Reading View and Live Preview, using your theme’s styles.
</p>

<p align="center">
<a href="https://obsidian.md/plugins?id=colsdown"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/badge/Install_in_Obsidian.svg?variant=default&amp;size=sm&amp;font=geist&amp;mode=dark&amp;logo=obsidian&amp;color=a079ff&amp;logoColor=18181b&amp;valueColor=18181b&amp;labelTextColor=18181b&amp;gradient=a079ff%2Cac8aff%2C110"><img alt="Install in Obsidian" src="https://shieldcn.dev/badge/Install_in_Obsidian.svg?variant=default&amp;size=sm&amp;font=geist&amp;mode=light&amp;logo=obsidian&amp;color=7c3aed&amp;logoColor=ffffff&amp;valueColor=ffffff&amp;labelTextColor=ffffff&amp;gradient=7c3aed%2C8650eb%2C110" style="display:inline-block;margin:0;vertical-align:middle"></picture></a>
<a href="https://github.com/grafanaKibana/obsidian-colsdown/releases/latest"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/release/grafanaKibana/obsidian-colsdown/stable.svg?variant=outline&amp;size=sm&amp;font=geist&amp;mode=dark&amp;label=Version&amp;gradient=18181b%2C18181b%2C90&amp;labelTextColor=fafafa"><img alt="Latest version" src="https://shieldcn.dev/github/release/grafanaKibana/obsidian-colsdown/stable.svg?variant=outline&amp;size=sm&amp;font=geist&amp;mode=light&amp;label=Version&amp;gradient=fafafa%2Cfafafa%2C90&amp;labelTextColor=18181b" style="display:inline-block;margin:0;vertical-align:middle"></picture></a>
<a href="https://github.com/grafanaKibana/obsidian-colsdown/actions/workflows/ci.yml"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/ci/grafanaKibana/obsidian-colsdown.svg?variant=outline&amp;size=sm&amp;font=geist&amp;mode=dark&amp;label=CI&amp;workflow=ci.yml&amp;branch=main&amp;statusDot=true&amp;gradient=18181b%2C18181b%2C90&amp;labelTextColor=fafafa"><img alt="CI status" src="https://shieldcn.dev/github/ci/grafanaKibana/obsidian-colsdown.svg?variant=outline&amp;size=sm&amp;font=geist&amp;mode=light&amp;label=CI&amp;workflow=ci.yml&amp;branch=main&amp;statusDot=true&amp;gradient=fafafa%2Cfafafa%2C90&amp;labelTextColor=18181b" style="display:inline-block;margin:0;vertical-align:middle"></picture></a>
</p>

Put related Markdown side by side: notes and actions, a short reference and a longer explanation, or two code examples. Columns use your theme’s styles and stack automatically when the pane becomes narrow.

<details>
<summary>Watch Colsdown in Obsidian</summary>

![Colsdown: responsive Markdown columns with in-place editing.](docs/assets/colsdown-demo.gif)

</details>

## Get started

[Install and enable Colsdown](#install), then run **Colsdown: Insert 2 columns** from the command palette. Replace the inserted content, or paste this example:

```markdown
%% cols %%
## Notes
Record the discussion here.

%% col %%
## Actions
- [ ] Review the proposal
%% endcols %%
```

The first column begins immediately after `%% cols %%`. Each `%% col %%` starts another, and `%% endcols %%` closes the layout. Keep markers on their own lines. An explicit first `col` can set the first column’s width or keep it empty.

## Editing

Open Live Preview and click a column to edit it while neighboring columns remain rendered. Arrows move between columns and into or out of the layout; Cmd/Ctrl+A selects the active column’s text. Use Source Mode when you want to change the layout markers or fences directly.

Column bodies can contain ordinary Markdown, footnotes, code blocks, and nested layouts. Reading View displays the resulting layout without opening an editor.

## Configuration

Drag a divider, or focus it and use the arrow keys, to adjust column widths. The change saves on release; Escape cancels. Select **+** to append another column.

For source-defined widths, use `%% col:60 %%` for 60% or `%% col:2fr %%` for a fractional width. Leave the width out for automatic sizing. The first column shares the remaining space when later columns have explicit widths.

Settings provide spacing, dividers, responsive sizing, and named presets. Columns adapt to narrow panes, including mobile. To arrange sections vertically from the start, use `%% cols:stack %%` instead of `%% cols %%`.

## Source formats

Comment markers and fenced blocks support the same layout features. Choose **Settings → Colsdown → Insertion format → Code block** to make commands and presets insert fences:

````markdown
```colsdown
## Notes
Record the discussion here.

::: 60%
## Actions
- [ ] Review the proposal
```
````

Use a `stack` fence for vertical sections. When nesting a code block, make the outer fence longer than the fences inside it. Marker and fenced layouts can also nest inside each other; the [nested examples](demo/Colsdown%20nested%20layouts.md) show both directions.

## Guides

- [Marker examples](demo/Colsdown%20markers.md) — Write percentage, fractional, and automatic-width columns with comment markers.
- [Fenced layouts](demo/Colsdown%20fenced%20layouts.md) — Create columns and stacks with code blocks, including nested code examples.
- [Nested layouts](demo/Colsdown%20nested%20layouts.md) — Combine columns and stacks across marker and fenced formats.
- [Demo test matrix](demo/Colsdown%20test%20matrix.md) — Explore layout, editing, resizing, and content examples.

## Install

Install with [BRAT](https://github.com/TfTHacker/obsidian42-brat) using `grafanaKibana/obsidian-colsdown`, or copy `main.js`, `manifest.json`, and `styles.css` from the same [release](https://github.com/grafanaKibana/obsidian-colsdown/releases) into `<Vault>/.obsidian/plugins/colsdown/`. Reload Obsidian and enable **Colsdown**.

Runs locally on desktop and mobile, with no network requests, telemetry, or account.

[Report an issue](https://github.com/grafanaKibana/obsidian-colsdown/issues) | [Contributing](CONTRIBUTING.md) | [License](LICENSE)
