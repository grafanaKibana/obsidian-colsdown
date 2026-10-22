---
title: Colsdown markers
tags:
  - colsdown/demo
---

# Colsdown markers

[[Colsdown test matrix|All demos]] · [[Colsdown markers|Markers]] · [[Colsdown fenced layouts|Fenced layouts]] · [[Colsdown nested layouts|Nested layouts]] · [[Colsdown footnote regressions|Footnote regressions]]

Comment markers keep layouts in ordinary Markdown. The first column starts immediately after `%% cols %%`; `%% col %%` starts the next. For nesting and mixed syntax, see [[Colsdown nested layouts]].

### Percentage columns and shared footnotes

%% cols %%
Sidebar with a shared footnote[^marker-shared].

%% col:60 %%
Main content uses the same definition[^marker-shared].

[^marker-shared]: Shared marker-layout definition with **Markdown**.
%% endcols %%

### Automatic and fractional columns

%% cols %%
One share.

%% col:2fr %%
Two shares.

%% col %%
Automatic width.
%% endcols %%

### Code examples remain code

```markdown
%% cols %%
This example stays raw code.
%% col %%
No columns here.
%% endcols %%
```

### Source edits

%% cols %%
Resize these columns, then inspect their saved widths.

%% col:60 %%
Add a column here, then inspect the note's markers and this surrounding text.
%% endcols %%

The configured fenced separator does not affect these layouts. In Settings, switch the insertion format and try existing commands, the custom dialog and a saved preset; fenced syntax remains supported.
