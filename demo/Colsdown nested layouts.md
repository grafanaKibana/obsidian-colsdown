---
title: Colsdown nested layouts
tags:
  - colsdown/demo
---

# Colsdown nested layouts

[[Colsdown test matrix|All demos]] · [[Colsdown markers|Markers]] · [[Colsdown fenced layouts|Fenced layouts]] · [[Colsdown nested layouts|Nested layouts]] · [[Colsdown footnote regressions|Footnote regressions]]

Check that nested stacks keep their sections vertical while nested columns remain side by side in a wide enough container. These fixtures combine markers and fences.

### Mixed nested layouts

%% cols %%
Outer left column.

%% cols:stack %%
Nested stack first section.

%% col %%
Nested stack second section.
%% endcols %%

%% col %%
```colsdown
Fenced child left.
:::
Fenced child right.
```
%% endcols %%

````colsdown
Marker child inside a fenced layout:

%% cols %%
Nested marker left.
%% col %%
Nested marker right.
%% endcols %%

:::
Outer fenced right.
````
