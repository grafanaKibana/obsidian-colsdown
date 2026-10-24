---
title: Colsdown test matrix
tags:
  - colsdown/demo
---

# Colsdown test matrix

Start with a syntax guide, then check the focused regression notes.

- [[Colsdown markers]] — percentage, fractional and automatic widths; resize and add-column source edits.
- [[Colsdown fenced layouts]] — automatic and explicit widths, embedded code and stacks.
- [[Colsdown nested layouts]] — mixed marker/fence nesting and stacked children.
- [[Colsdown footnote regressions]] — shared definitions, literal-source controls and historical issue #4 acceptance.

## Editing and navigation

In Live Preview, click or arrow into a column to edit its Markdown while its siblings stay rendered. Continue with arrows through the columns and out into the note; Up/Left reverse the path. Cmd/Ctrl+A selects that column's text. This also works in fenced layouts. Source Mode shows all markers and fences. Try the divider and **+** button: saved changes should keep comment markers, surrounding text and nested Markdown.

## Footnotes — issue #4

Regression tracking for [issue #4](https://github.com/grafanaKibana/obsidian-colsdown/issues/4). These cases include controls that should already work and references whose definitions are outside their rendered column. Leave checks unchecked until verified in Obsidian Reading View.

### Native Markdown control

This reference is outside Colsdown[^demo-native]. Its definition is at the bottom of this note.

### Definition in the same column

```colsdown
This reference and its definition share one column[^demo-local].

[^demo-local]: Same-column definition with **bold text** and an [external link](https://obsidian.md).

:::

Second column without a footnote.
```

### Definition below the layout

```colsdown
This reference uses a definition at the bottom of the note[^demo-external].

:::

Second column without a footnote.
```

### Definition in another column

```colsdown
The definition for this reference is in the second column[^demo-cross-column].

:::

[^demo-cross-column]: A definition in another column must resolve without a local reference.
```

### Shared definition across Markdown and multiple layouts

Ordinary Markdown also references the shared definition[^demo-shared]. All occurrences should point to one definition, with working return links.

```colsdown
First occurrence in a column[^demo-shared]; repeated occurrence[^demo-shared].

:::

The other column uses the same definition[^demo-shared].
```

```colsdown
A separate layout reuses the shared definition[^demo-shared].

:::

This named footnote has a multiline definition below the note[^demo-multiline].
```

### Inline footnotes and a nested stack

````colsdown
An inline footnote contains its own definition.^[Inline text with *emphasis*.]

:::

```stack
Nested stack reference[^demo-nested].

:::

Another stack section.
```
````

### Footnote syntax inside code stays literal

````colsdown
Neither this inline code `[^demo-code]` nor the fenced example below is a footnote.

```markdown
Example reference[^demo-code].

[^demo-code]: This is example code, not a real definition.
```

:::

An undefined real reference[^demo-code] must retain Obsidian's native unresolved-reference behavior, without using the definition inside the code example.
````

## Footnote fix acceptance checks

- [ ] Native Markdown and same-column controls still render correctly.
- [ ] Definitions below the layout and in another column resolve to linked footnotes.
- [ ] Shared references use consistent numbering and one note-level definition, with a working return link for every occurrence.
- [ ] Named and multiline definitions preserve formatting and links.
- [ ] Inline footnotes and references inside a nested stack render correctly.
- [ ] Footnote syntax inside inline or fenced code stays literal and supplies no definitions.
- [ ] Editing a definition, removing a layout, and switching modes leave no stale or duplicate footnotes.
- [ ] Two panes showing this note keep independent footnote links and render state.
- [ ] Light/dark themes and narrow layouts preserve readable footnotes and working navigation.

## Manual checks

- [ ] Reading View renders each case.
- [ ] 70% column is wider than its remaining-space first column.
- [ ] Nested code fence is rendered inside the first item.
- [ ] Narrow container collapses every column layout without horizontal overflow.
- [ ] Light and dark themes add no Colsdown-owned hover color or background.
- [ ] Settings update gap, divider, minimum width, and breakpoint without reload.
- [ ] Every insertion command is undoable.
- [ ] Live Preview remains editable and does not change this file.
