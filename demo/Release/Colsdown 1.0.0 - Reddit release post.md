---
status: draft
platform: Reddit
community: r/ObsidianMD
created: 2026-09-28
release: https://github.com/grafanaKibana/obsidian-colsdown/releases/tag/1.0.0
---

# Colsdown 1.0.0 release post

## Image

![Colsdown 1.0.0 release poster with purple and green column shapes, a resize arrow, and an orange version badge.](assets/colsdown-v1-release.png)

[Editable vector artwork](assets/colsdown-v1-release.svg)

## Reddit title

I made Colsdown: resizable Markdown columns and presets for Obsidian (v1.0)

## Post

I tried CSS snippets and an existing columns plugin, but kept getting stuck on styling: settings didn't seem to take effect, and hover effects added colors I didn't want.

So I built **Colsdown** around what I wanted: a lightweight plugin, readable Markdown, Obsidian's own renderer, and my theme's styles. Layouts use a short code block with `:::` separators. No callout setup or custom editor.

**Version 1.0.0 is out now.** Here's what it includes:

- **Columns and vertical stacks**, with nested layouts and code blocks. Layouts adapt to narrow panes and mobile screens.
- **Drag to resize in 5% steps.** Widths save into the note when you release. Arrow keys work too; Escape cancels. There's a small spring effect with reduced-motion support.
- **Add a column with +.** Existing percentage columns shrink proportionally to make room.
- **Reusable presets and insertion commands.** Set up each column in native Obsidian settings, then insert the layout from the command palette. Renaming a preset keeps its hotkey.
- **Auto, percentage and `fr` widths**, with validation for custom layouts and presets.
- **Adjustable gaps, minimum widths, stacking breakpoint, separators and dividers.** Content uses Obsidian's renderer and your theme.
- **Free, MIT-licensed and local.** No account, telemetry or network requests.

A 30/70 layout is just:

````markdown
```colsdown
Research notes

::: 70%
Draft goes here
```
````

**[Download v1.0.0](https://github.com/grafanaKibana/obsidian-colsdown/releases/tag/1.0.0)** · **[Docs and examples](https://github.com/grafanaKibana/obsidian-colsdown#readme)**

Install through BRAT using `grafanaKibana/obsidian-colsdown`, or copy the three release files into your vault's plugin folder. Requires Obsidian 1.12.7+.

Would love to see what you build with it, and hear what feels awkward.

---

## Posting notes

- Upload `assets/colsdown-v1-release.png` as the post image. Copy the title and Post section above.
- `assets/colsdown-v1-release.svg` is the editable vector source. It contains vector shapes, editable text and embedded Geist fonts.
- Suggested alt text: “Colsdown 1.0.0 release poster: purple and green columns, nested sections, a resize arrow and an orange version badge. Drag to resize, nest your layouts, save your presets.”
- Artwork is an original vector composition, exported to PNG at 1600 × 1200.
- The opening is grounded in the August 20 project discussion: style settings did not seem to apply and hover coloring was unwanted. The follow-up brief requested a lightweight plugin with readable Markdown and native rendering.
