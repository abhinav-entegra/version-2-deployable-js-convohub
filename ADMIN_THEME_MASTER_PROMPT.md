# AnyWhere Admin Dashboard — Master UI Theme Prompt (Theme Only)

Use this prompt to recreate the **exact visual theme** of the AnyWhere **Admin Dashboard** in a different Cursor/workspace.

## Scope (Hard Rules)
- **Theme only**: colors, typography, shadows, radii, borders, translucency/blur, hover/active/focus states, motion/animation feel, and background textures.
- **Do NOT copy layout**: do not add/modify screens, sections, grids, positioning, or information architecture unless explicitly required to apply the theme.
- **Do NOT invent a different design system**: replicate this one precisely (values included below).

## Brand / Aesthetic Summary
- **Overall vibe**: clean “Apple-like” modern admin UI: soft light-gray app background, white cards, subtle borders, gentle elevation, pill chips, and glassy blurred overlays.
- **Contrast**: low-noise neutrals with one strong system accent (iOS-style blue) plus semantic status colors (green/amber/red).
- **Surfaces**: layered cards/panels/popovers with small-to-medium shadows; borders are thin and slightly warm-gray.
- **Texture**: some canvases use a **radial dot-grid** background pattern in light gray.

## Typography
- **Primary font**: `Inter` (Google Fonts), weights 300/400/500/600/700.
- **Fallback stack**: `-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif`.
- **Base text color**: `#1d1d1f`.
- **Smoothing**: enable `-webkit-font-smoothing: antialiased;` and `-moz-osx-font-smoothing: grayscale;`.
- **Micro-typography**:
  - Frequent slightly-negative tracking on headings/brand labels: e.g. `letter-spacing: -0.3px` to `-0.2px`.
  - Small uppercase labels use stronger tracking: `letter-spacing: 0.04em`–`0.08em`.

## Global Base (Exact)
- Page background: `#f5f5f7`
- Default text: `#1d1d1f`
- Disable selection: `user-select: none;` (product/app-shell feel)
- Scrollbar (WebKit):
  - width `6px`
  - thumb `#d1d1d6`, radius `3px`, hover `#aeaeb2`

## Design Tokens (Exact CSS Variables)
Create these as the **single source of truth** (CSS variables, theme object, tokens file—any is fine as long as values match exactly).

```css
:root {
  --bg-app: #f5f5f7;
  --bg-card: #ffffff;
  --bg-card-hover: #fafafa;
  --bg-header: rgba(255,255,255,0.80);
  --bg-dock: rgba(255,255,255,0.82);
  --bg-input: #f5f5f7;
  --bg-panel: #ffffff;

  --border: #e2e2e7;
  --border-light: #ebebef;
  --border-active: #007aff;

  --text-primary: #1d1d1f;
  --text-secondary: #6e6e73;
  --text-dim: #aeaeb2;

  --accent-gold: #bf8f00;
  --accent-green: #30d158;
  --accent-blue: #007aff;
  --accent-blue-hover: #0066d6;
  --accent-red: #ff3b30;
  --accent-amber: #ff9f0a;

  --shadow-xs: 0 1px 2px rgba(0,0,0,0.04);
  --shadow-sm: 0 1px 4px rgba(0,0,0,0.06), 0 2px 8px rgba(0,0,0,0.04);
  --shadow-md: 0 4px 16px rgba(0,0,0,0.08);
  --shadow-lg: 0 8px 32px rgba(0,0,0,0.10), 0 2px 8px rgba(0,0,0,0.04);
  --shadow-panel: 0 8px 40px rgba(0,0,0,0.12), 0 2px 10px rgba(0,0,0,0.05);

  --radius-sm: 10px;
  --radius-md: 14px;
  --radius-lg: 20px;
  --radius-pill: 999px;

  --spring: cubic-bezier(0.32, 0.72, 0, 1);
}
```

## Component Theme Rules (Apply Everywhere)

### Surfaces (Cards / Panels / Popovers)
- **Default card**: `background: var(--bg-card)` with `border: 1px solid var(--border)` and elevation around `var(--shadow-sm)`.
- **Hover elevation**: increase shadow to around `var(--shadow-md)` and apply a tiny lift: `transform: translateY(-1px)` to `-2px` using `transition: ... var(--spring)`.
- **Panel/modal**: rounded (often 18–20px), subtle border (`var(--border-light)` or `rgba(0,0,0,0.06)`), deeper shadow (`var(--shadow-panel)` or `0 18px 48px rgba(0,0,0,0.24)` for big modals).

### Inputs
- Background: `var(--bg-input)`
- Border thickness: **1.5px** with `var(--border)`
- Focus ring: blue border + soft outer ring:
  - `border-color: var(--accent-blue);`
  - `box-shadow: 0 0 0 3px rgba(59,130,246,0.12);` (or tighter 2px ring for some search inputs)
- Placeholder: `var(--text-dim)`

### Buttons
- **Primary**: solid `var(--accent-blue)` with hover `var(--accent-blue-hover)`, slight press scale: `transform: scale(0.98)`.
- **Secondary**: `var(--bg-input)` with 1.5px border, subtle hover background `rgba(0,0,0,0.04)`.
- **Ghost**: transparent with border, hover `rgba(0,0,0,0.03)` and text shifts from secondary to primary.

### Chips / Pills
- Use `--radius-pill` heavily.
- Background often a faint neutral wash: `rgba(0,0,0,0.04)`; active chip becomes white card with `--shadow-xs`.

### Status Colors
- **Online/Streaming**: `var(--accent-green)`; sometimes add glow: `0 0 6px rgba(34,197,94,0.5)`.
- **Online (amber)**: `var(--accent-amber)` with gentle glow `rgba(245,158,11,0.5)`.
- **Error/Destructive**: `var(--accent-red)`; notification badges often pure red `#ff3b30`.

### Translucency + Blur (Key “Apple” feel)
Use blur on floating layers:
- Backdrops: `background: rgba(0,0,0,0.12)` to `0.18` plus `backdrop-filter: blur(10px)` or more.
- Glass bars/popovers/toasts:
  - backgrounds like `rgba(255,255,255,0.94)` and blur `16px`–`40px`.
- Dock bar specifically: `background: var(--bg-dock)` with `backdrop-filter: blur(28px)` and a soft border `rgba(0,0,0,0.06)`.

### Motion
- Use fast, confident transitions (100–400ms) with the theme easing:
  - `transition-timing-function: var(--spring);`
- Common patterns:
  - Fade/slide-up for cards: opacity + translateY.
  - Slide-in panels: translateX from offscreen with spring.
  - Pop badges: scale from 0 to 1 with a snappy cubic-bezier.

## Background Texture (Dot Grid)
Some canvases use a light dot-grid:
- Example pattern:
  - `background-color: #fafafa;`
  - `background-image: radial-gradient(circle, #d4d4d8 0.8px, transparent 0.8px);`
  - `background-size: 24px 24px;`
And similar variants:
- `#f5f5f7` + dot color `#d1d1d6` at `0.7px`, size `22px`.
- Canvas boards: `#f8f8fa` with dots `rgba(0,0,0,0.055)` at `1px`, size `24px`.

## Implementation Instructions (What to Output)
When applying this theme to a new codebase:
- Create a **theme tokens file** (CSS variables or equivalent) with the **exact values** above.
- Ensure global base styles match:
  - font import (Inter),
  - base background/text colors,
  - scrollbar styling,
  - smoothing,
  - low-noise neutral palette.
- Apply consistent component styling:
  - 1.5px input borders,
  - pill radii,
  - soft shadows,
  - blue focus rings,
  - blur/glass overlays where applicable.

## Anti-Drift Constraints (Important)
- Do not introduce dark mode unless explicitly asked.
- Do not change the accent blue away from `#007aff`.
- Keep borders subtle (no heavy outlines).
- Keep shadows soft and layered (avoid harsh drop shadows).
- Keep the UI “quiet”: most elements use `--text-secondary` and only key actions use accent blue.

## Source of Truth (Where This Came From)
This theme is derived from the admin dashboard’s real styles:
- `admin-dashboard/src/index.css` (global base + font + scrollbar + base colors)
- `admin-dashboard/src/App.css` (tokens + surfaces + interactions + blur + shadows + motion)

