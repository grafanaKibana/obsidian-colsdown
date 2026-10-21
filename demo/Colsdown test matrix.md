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

## Manual checks

- [ ] Reading View renders each case.
- [ ] 70% column is wider than its remaining-space first column.
- [ ] Nested code fence is rendered inside the first item.
- [ ] Narrow container collapses every column layout without horizontal overflow.
- [ ] Light and dark themes add no Colsdown-owned hover color or background.
- [ ] Settings update gap, divider, minimum width, and breakpoint without reload.
- [ ] Every insertion command is undoable.
- [ ] Live Preview remains editable and does not change this file.
