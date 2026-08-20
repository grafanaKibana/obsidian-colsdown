# Colsdown

Colsdown turns ordinary Markdown into responsive columns and vertical stacks in Obsidian. It uses Obsidian's renderer, keeps note content readable, and adds no hover colors, card backgrounds, or theme overrides.

## What it does

- Renders fenced `colsdown` blocks as responsive columns in Reading View.
- Uses content before the first separator as the first column, so the opening `:::` marker is optional.
- Supports percentages, fractional widths, automatic columns, vertical `stack` blocks, nested layouts, and nested code fences.
- Collapses columns below a configurable container width without horizontal overflow.
- Provides commands for common layouts and settings for the separator, gap, minimum width, breakpoint, and divider.
- Runs on desktop and mobile without runtime dependencies, network requests, or telemetry.

## Syntax

Content before the first `:::` is the first column. A width on a later separator belongs to the column after it; the first column uses the remaining space.

`````markdown
````colsdown
Sidebar content

::: 70%

Main content

```javascript
console.log("Nested fences stay inside the column.");
```
````
`````

The example renders a 30/70 layout. For equal automatic columns, omit widths:

````markdown
```colsdown
First column

:::

Second column
```
````

Explicit markers before every column are also accepted:

````markdown
```colsdown
::: 25%
Navigation

::: 75%
Article
```
````

Use `fr` units when you want fractional tracks:

````markdown
```colsdown
::: 1fr
Small

::: 2fr
Large
```
````

Use a `stack` fence for vertically separated sections:

````markdown
```stack
:::
First section

:::
Second section
```
````

The separator can be changed in **Settings → Colsdown**. Colsdown recognizes the canonical `:::` separator as well as the configured separator, locks each block to the first separator it sees, and ignores marker-looking lines inside nested backtick or tilde fences.

## Obsidian modes

| Mode | Behavior |
| --- | --- |
| Reading View | Responsive rendered columns and stacks on desktop and mobile. |
| Live Preview | Editable fenced Markdown; note content remains unchanged. |
| Source Mode | Raw fenced Markdown only. |

## Commands

- **Colsdown: Insert 2 columns**
- **Colsdown: Insert 3 columns**
- **Colsdown: Insert 30/70 sidebar**
- **Colsdown: Insert stack**
- **Colsdown: Insert custom columns**

Every insertion is a normal editor change and can be undone.

## Installation

### Community plugins

Use this method after Colsdown is listed in Obsidian's Community Plugins directory:

1. Open **Settings → Community plugins**.
2. Select **Browse**, search for **Colsdown**, then select **Install**.
3. Select **Enable**.

### BRAT

Published releases and prereleases can be installed with [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install and enable **Obsidian42 - BRAT**.
2. Run **BRAT: Add a beta plugin for testing**.
3. Enter `grafanaKibana/obsidian-colsdown`.
4. Enable **Colsdown** under **Settings → Community plugins**.

BRAT can install only a published release or prerelease, not an unpublished draft.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the same [GitHub release](https://github.com/grafanaKibana/obsidian-colsdown/releases).
2. Create `<Vault>/.obsidian/plugins/colsdown/`.
3. Copy the three files into that directory.
4. Reload Obsidian and enable **Colsdown**.

Do not mix assets from different releases.

## Troubleshooting

- **Fenced source instead of columns:** Enable Colsdown and switch to Reading View.
- **Columns are stacked:** Increase the layout's available width or lower the responsive breakpoint.
- **A marker does not split the block:** Put it on its own line and keep using the same separator throughout that block.
- **An inner code block closes Colsdown:** Make the outer fence longer than every matching fence inside it, or use tildes.
- **An embed or plugin block fails:** Test the same Markdown outside Colsdown first.
- **Still stuck:** [Open an issue](https://github.com/grafanaKibana/obsidian-colsdown/issues) with a minimal source block, Obsidian version, theme, and related plugins.

## Development and releases

- [Contributing and local development](CONTRIBUTING.md)
- [Issues](https://github.com/grafanaKibana/obsidian-colsdown/issues)
- [Releases and changelog](https://github.com/grafanaKibana/obsidian-colsdown/releases)

Colsdown runs entirely inside Obsidian and makes no network requests. It collects no telemetry, requires no account or payment, shows no advertising, accesses only files inside the vault, and includes no closed-source components.

## License

[MIT](LICENSE)
