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
  brand-regular:
    fontFamily: "Geist, sans-serif"
    fontWeight: 400
  brand-bold:
    fontFamily: "Geist, sans-serif"
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

The frontmatter records established brand anchors. Paper and ink carry the type; purple and lavender demonstrate nesting, lime holds presets and reuse, and orange identifies the version. The approved raster has softly varied fills, so these anchors are not a claim that every pixel matches a token.

## Typography

The approved PNG uses bold Geist-like sans lettering, with an oversized product name and nested-layout phrase. Its lettering is generated raster content; exact font metrics and weights are not recoverable. The brand typography tokens come from the older editable `docs/assets/colsdown-v1.0-release.svg`, which embeds Geist regular 400 and bold 700.

## Layout

The approved `docs/assets/colsdown-v1-release.png` is a static 4:3 image (1448 × 1086). Its cream title region, orange version notch, lavender resize rail, nested central field, lime preset column and lower editing/navigation copy form one composition. The surface brief records its exact arrangement.

Scale the whole image proportionally in README and listing contexts; there is no separate mobile composition. Keep all six benefits represented: resizing, nesting, editing, arrow navigation, presets and reuse.

## Elevation & Depth

Colored region containment carries depth. Preserve the approved raster's subtle fill variation; do not infer CSS shadows or motion from it.

## Shapes

Upright regions, a rounded lavender inset, one circular resize handle, an insertion caret and a right-angle arrow explain the mechanism. Preserve their relationships in the approved image.

## Components

This asset defines poster regions, not an application component library. The sidecar includes one self-contained nested-region CSS specimen to illustrate the palette and containment; it is not a reconstruction or replacement of the approved raster.

## Do's and Don'ts

- Do preserve the approved raster and its provenance together.
- Do retain the six benefits and the established palette.
- Don't substitute a new composition for the approved poster.
- Don't describe generated lettering as embedded Geist fonts.
