# Colsdown test matrix

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

## Manual checks

- [ ] Reading View renders each case.
- [ ] 70% column is wider than its remaining-space first column.
- [ ] Nested code fence is rendered inside the first item.
- [ ] Narrow container collapses every column layout without horizontal overflow.
- [ ] Light and dark themes add no Colsdown-owned hover color or background.
- [ ] Settings update gap, divider, minimum width, and breakpoint without reload.
- [ ] Every insertion command is undoable.
- [ ] Live Preview remains editable and does not change this file.
