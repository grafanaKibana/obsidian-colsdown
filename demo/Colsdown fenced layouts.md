---
title: Colsdown fenced layouts
tags:
  - colsdown/demo
---

# Colsdown fenced layouts

[[Colsdown test matrix|All demos]] · [[Colsdown markers|Markers]] · [[Colsdown fenced layouts|Fenced layouts]] · [[Colsdown nested layouts|Nested layouts]] · [[Colsdown footnote regressions|Footnote regressions]]

Try automatic widths, percentage widths, embedded code and stacked sections. For mixed syntax, see [[Colsdown nested layouts]].

## Automatic columns

```colsdown
First automatic column

:::

Second automatic column
```

## Remaining-space first column

```colsdown
This first column uses the remaining 30%.

::: 70%

This column uses 70%.
```

## Explicit widths

```colsdown
::: 25%
Quarter

::: 75%
Three quarters
```

## Nested code fence

````colsdown
Source stays intact:

```javascript
console.log(":::");
```

::: 50%

Second column
````

## Stack

```stack
:::
First section

:::
Second section
```
