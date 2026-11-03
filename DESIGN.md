---
version: alpha
colors:
  primary: '#243882'
  ink: '#172642'
  muted: '#58677d'
  line: '#dfe5ee'
  canvas: '#f3f6fa'
  surface: '#ffffff'
  navy: '#18274d'
  success: '#187760'
typography:
  body:
    fontFamily: 'Segoe UI, Microsoft YaHei UI, sans-serif'
    fontSize: 14px
    lineHeight: '1.6'
  data:
    fontFamily: 'Cascadia Code, Consolas, monospace'
    fontSize: 12px
rounded:
  control: 6px
  panel: 10px
spacing:
  page: 36px
  compactPage: 16px
components:
  navigation:
    width: 236px
  button:
    height: 40px
---
# Stellantis vehicle workspace

## Overview
Operate mode. Reference: https://www.stellantis.com/en . Deep blue navigation anchors a white, quietly structured engineering workspace. The approved direction is restraint and precision, not a marketing landing page.

## Colors
Canonical runtime values live in src/theme.ts; installThemeTokens maps the palette to root CSS variables before React renders, and App.tsx adapts the same palette to Ant Design. Refined.css owns the presentation layer. Existing specialized component styles remain in their owners.

## Typography
Local Windows fonts avoid font downloads and layout shifts. Semibold page titles, regular body text, tabular numerals, and monospace only for identifiers. Preserve Chinese font fallbacks.

## Layout
236px deep-blue navigation; 70px header; 36px desktop page inset. White table surface, subdued summary strip, left-aligned vehicle identity. At 1050px navigation contracts; at 700px navigation moves into document flow. Table overflow stays owned by the existing table primitive. Forms retain document scrolling.

## Elevation & Depth
Use hairline boundaries rather than decorative shadows or backdrop blur. Drawer headers use a cool tinted surface.

## Shapes
6px operational controls, 8px login controls, 10px operational panels, circular user avatar. No decorative cards or additional hero content in operational screens.

## Components
Ant Design owns controls, dialogs, drawers and notifications; Lucide owns icons. ResizableVehicleTable owns table sizing, filters, pagination and preferences. A centered single-column login restores the original entry composition. Its top anchor and reserved 64px bilingual title prevent content-height recentering during locale and login/register changes.

## Do's and Don'ts
Keep feedback immediate. Hover transitions take 120ms; the login entrance takes 180ms. Reduced motion disables authored motion. Preserve lazy business/report loading and existing request caching. No animation timers, new production libraries, remote fonts, or extra business requests. Global visible scrollbars inherit palette; forced colors remains system-owned. Preview captures use explicitly synthetic browser-intercepted records only.

Refinement approved 2026-11-03: keep the operational structure; use Apple-like restraint in spacing and quiet surfaces. Remove the split login, preserve Stellantis branding, no new dependencies or motion.
