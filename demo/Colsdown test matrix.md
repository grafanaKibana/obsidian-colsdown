---
summary: |
  [^demo-metadata-only]: This YAML value must not become a Markdown footnote.
---

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

## Footnotes — issue #4

Regression tracking for [issue #4](https://github.com/grafanaKibana/obsidian-colsdown/issues/4). These cases include controls that should already work and references whose definitions are outside their rendered column. Footnote numbering and sections are independent within each rendered item. Checked cases were verified in native Obsidian desktop acceptance; see the verification note below.

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

Ordinary Markdown also references the shared definition[^demo-shared]. Each rendered item should resolve the shared definition with working return links. A single definition shared by the whole note is a future enhancement.

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

### Review regressions: containers, nested lists, punctuation and frontmatter

> [!note] Callout layout
> ```colsdown
> A callout reference resolves the outside definition[^demo-external].
> ```

- List container
    ```stack
    A list-contained stack resolves the outside definition[^demo-external].
    ```

```colsdown
- Parent
    - Nested child resolves the outside definition[^demo-external].

\![^demo-external] keeps a literal exclamation mark followed by a footnote.

This YAML-only label must remain unresolved[^demo-metadata-only].

    Indented code[^demo-external] stays literal.
```

### Review regressions: marker-line fences and opaque HTML

- ```colsdown
  A fence starting on its list marker resolves the outside definition[^demo-external].
  ```

1. ```stack
   Ordered-list fences resolve the same outside definition[^demo-external].
   ```

```colsdown
\<!-- This escaped HTML opener stays text; its reference resolves[^demo-external].

HTML example definitions must remain unresolved[^demo-html-only].
```

<pre>
[^demo-html-only]: Literal HTML example, not a Markdown definition.
</pre>

   ````colsdown
   A reference resolves a definition in an indented nested layout[^demo-indented-nested].
   :::
      ```stack
      [^demo-indented-nested]: The containing fence indentation is removed before collecting this definition.
      ```
   ````

### Review regressions: escaped backticks, math and tables

```colsdown
\`Literal backticks still allow this footnote[^demo-external].\`

An unterminated inline opener stays literal <!-- and this reference resolves[^demo-external].

Math and table HTML must supply no definitions[^demo-math-only][^demo-table-html-only].
```

$$
[^demo-math-only]: Formula annotation
$$

Name | Value
--- | ---
Example | Control
<widget>
[^demo-table-html-only]: Raw HTML after a table, not a Markdown footnote.
</widget>

> Text <!--

```stack
This layout still resolves after the quote's inline-comment boundary[^demo-external].
```

## Footnote fix acceptance checks

- [x] Native Markdown and same-column controls still render correctly.
- [x] Definitions below the layout and in another column resolve to linked footnotes.
- [x] Every shared/repeated reference has a working target and return link within its rendered item.
- [ ] Future note-wide consolidation: shared references use consistent numbering and one note-level definition (outside the current fix).
- [x] Named and multiline definitions preserve formatting and links.
- [x] Inline footnotes and references inside a nested stack render correctly.
- [x] Footnote syntax inside inline or fenced code stays literal and supplies no definitions.
- [x] Editing a definition, removing a layout, and switching modes leave no stale or duplicate footnotes.
- [x] Callout/list layouts, nested-list references and escaped exclamation marks resolve external definitions.
- [x] List-marker fences, escaped HTML openers and indented nested definitions resolve correctly.
- [x] Escaped backticks and comment boundaries preserve real references; math and table HTML supply no definitions.
- [x] Raw HTML and code beyond an implicitly ended container supply no definitions.
- [x] YAML-only definition text stays unresolved; ordinary indented/fenced code stays literal.
- [x] Two panes showing this note keep independent footnote links and render state.
- [x] Light/dark themes and narrow layouts preserve readable footnotes and working navigation.

Verification: Obsidian 1.12.7 and 1.13.7 desktop app packages, using the installed macOS Electron runtime. Refresh, heading-embed, nested-layout, navigation and lifecycle receipts are retained in the issue #4 QA artifacts. Light/dark and narrow desktop screenshots are recorded; actual mobile-device verification remains pending. Review regressions and container definition refresh were rechecked with the updated bundle in native Obsidian 1.13.7. The future note-wide consolidation case stays unchecked because this fix keeps numbering and footnotes sections independent per item.

## Manual checks

- [ ] Reading View renders each case.
- [ ] 70% column is wider than its remaining-space first column.
- [ ] Nested code fence is rendered inside the first item.
- [ ] Narrow container collapses every column layout without horizontal overflow.
- [ ] Light and dark themes add no Colsdown-owned hover color or background.
- [ ] Settings update gap, divider, minimum width, and breakpoint without reload.
- [ ] Every insertion command is undoable.
- [ ] Live Preview remains editable and does not change this file.

[^demo-native]: Native Markdown baseline outside all layouts.

[^demo-external]: This definition is outside the Colsdown fence and should appear in its reference's rendered item.

[^demo-shared]: One definition shared by ordinary Markdown, two columns, repeated references, and a second layout.

[^demo-multiline]: First line of a named footnote with **bold text**.
  Second line with *emphasis* and an [external link](https://obsidian.md).

[^demo-nested]: A nested stack must resolve definitions from its containing note.

### Review regressions: punctuation, headings and table cells

```colsdown
A reference followed by a colon[^review-boundaries]: remains a reference.

Text <!--
---
Visible after a heading[^review-boundaries].
-->

Table cells must not create definitions[^review-cell].
```

Name | Value
--- | ---
[^review-cell]: Literal table cell | Other

[^review-boundaries]: Review tracking: colon punctuation and heading/thematic breaks preserve active references; table cells do not define footnotes.

### Review regressions: multiline code and quoted definitions

```colsdown
A valid quoted footnote[^review-quoted].

Literal code must not define a footnote[^review-code].
```

`literal code spanning lines
[^review-code]: Literal example inside code.
end of code`

[^review-quoted]: First paragraph.
    > Valid four-space quoted continuation.
