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
    fontSize: "144px"
    fontWeight: 700
  poster-subtitle:
    fontFamily: "Geist, sans-serif"
    fontSize: "40px"
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

The frontmatter records established brand anchors. Paper and ink carry the type; purple and lavender demonstrate nesting, lime holds presets and reuse, and orange identifies the version. The approved raster has softly varied fills, so these anchors are not a claim that every pixel matches a token.

## Typography

The editable `docs/assets/colsdown-v1-release.svg` embeds Geist regular and bold over the generated background. Its title, subtitle, version and feature roles use the exact frontmatter scale. All six benefits share the feature size and bold weight, with equal baseline spacing. The PNG is a Chromium export of that source. The smaller title and metadata leave more breathing room; the nesting phrase has the same emphasis as the other benefits.

## Layout

The refined `docs/assets/colsdown-v1-release.png` is a static 4:3 image (1448 × 1086). Its cream title region, orange version notch, lavender resize rail, nested central field, lime preset column and lower editing/navigation copy form one composition. The surface brief records its exact arrangement.

Scale the whole image proportionally in README and listing contexts; there is no separate mobile composition. Keep all six benefits represented: resizing, nesting, editing, arrow navigation, presets and reuse.

## Elevation & Depth

Colored region containment carries depth. Preserve the approved raster's subtle fill variation; do not infer CSS shadows or motion from it.

## Shapes

Upright regions, a rounded lavender inset, one circular resize handle, an insertion caret and a right-angle arrow explain the mechanism. Preserve their relationships in the approved image.

## Components

This asset defines poster regions, not an application component library. The sidecar includes one self-contained nested-region CSS specimen to illustrate the palette and containment; it is not a reconstruction or replacement of the approved raster.

## Do's and Don'ts

- Do preserve the composition, editable source and generation provenance together.
- Do retain the six benefits and the established palette.
- Don't substitute a new composition for the approved poster.
- Don't give one benefit a different font size or weight from the other five.
