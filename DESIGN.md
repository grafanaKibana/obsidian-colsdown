---
name: Colsdown release poster
description: Established Colsdown identity and the approved static release artwork.
colors:
  paper: "#f4f0e7"
  ink: "#241a35"
  purple: "#7853ce"
  lavender: "#c9b8ef"
  lime: "#d5e8a5"
  orange: "#ff9b68"
typography:
  poster-title:
    fontFamily: "Geist, sans-serif"
    fontSize: "136px"
    fontWeight: 700
  poster-subtitle:
    fontFamily: "Geist, sans-serif"
    fontSize: "42px"
    fontWeight: 400
  poster-feature:
    fontFamily: "Geist, sans-serif"
    fontSize: "56px"
    fontWeight: 700
    lineHeight: "64px"
  poster-version:
    fontFamily: "Geist, sans-serif"
    fontSize: "64px"
    fontWeight: 700
---

# Design System: Colsdown release poster

## Overview

**Creative North Star: "The poster is the layout"**

Colsdown uses a cream ground, aubergine lettering and purple, lavender, lime and orange regions to make editable columns tangible. The approved release artwork keeps the established brand while making its composition demonstrate the product.

**Key Characteristics:**
- Bold typographic hierarchy
- Upright modular geometry
- Benefits integrated into the layout

## Colors

The frontmatter records established brand anchors. Paper and ink carry the type; purple and lavender demonstrate nesting, lime holds the preset library, and orange identifies the version. Solid SVG fills and rounded internal blocks make containment clear.

## Typography

The editable `docs/assets/colsdown-v1-release.svg` embeds Geist regular and bold alongside native SVG geometry. Its title, subtitle, version and feature roles use the exact frontmatter scale. All four benefit labels share the feature size and bold weight; multiline labels use the same baseline spacing. The PNG is a Chromium export of that source. The smaller title and metadata leave more breathing room; the nesting phrase has the same emphasis as the other benefits.

## Layout

The refined `docs/assets/colsdown-v1-release.png` is a static 4:3 image (1448 × 1086). Its cream title region, orange version card on cream, lavender resize rail, purple nested field, lime preset library and lower editing region form one composition. The surface brief records its exact arrangement.

Scale the whole image proportionally in README and listing contexts; there is no separate mobile composition. Keep the four visual demonstrations: resizing, nesting, presets and editing. Reuse and arrow navigation are omitted as separate pitches at the user’s request.

## Elevation & Depth

Colored region containment carries depth. Version, nesting parent/child cards, preset thumbnails and the active editing column share a soft aubergine shadow: 0px horizontal offset, 6px vertical offset, 8px Gaussian blur, 13% opacity. Solid fills stay intact; this static asset has no motion.

## Shapes

A rounded purple parent card and upright child blocks demonstrate nesting. The parent meets the lime preset rail without a vertical gutter; cream separates it from the version card, which has no purple backdrop. A circular double-arrow handle sits on the resize divider. A plus above two miniature layouts represents presets. An insertion caret in the active column sits beside a rendered sibling. Each diagram belongs to its corresponding label.

## Components

This asset defines poster regions, not an application component library. The sidecar includes one self-contained nested-region CSS specimen to illustrate the palette and containment; the shipping SVG remains the authority for exact geometry.

## Do's and Don'ts

- Do preserve the composition, editable source and native-source provenance together.
- Do retain the four mechanisms and the established palette.
- Don't replace mechanism illustrations with blank caption panels.
- Don't give one benefit a different font size or weight from the other three.
