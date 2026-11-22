# Plenary Visual & UX Design System

> **Scope**: Unified visual language, verified WCAG token system, custom SVG iconography, and interaction ergonomics across **Desktop Canvas**, **Phone / Chrome-on-iOS Canvas (390×844)**, and **Home / Admin Dashboard + Share & Audit Views**.
>
> **Interactive Mocks**:
> - Desktop Canvas: [mock-desktop.html](mock-desktop.html)
> - Phone / Chrome-on-iOS (390×844): [mock-phone.html](mock-phone.html)
> - Home / Admin + Share & Audit: [mock-admin.html](mock-admin.html)

---

## 1. Design Direction — "Warm Studio Craft"

Plenary is a collaborative infinite-canvas workspace. The chrome must feel like precision drafting instruments resting lightly over paper — never heavy, utilitarian, or visually competing with the user's diagram.

- **Warm neutral surfaces** (Light: `#F8F7F4` studio paper canvas + `#FFFFFF` floating chrome; Dark: `#111113` obsidian canvas + `#1A1A1E` floating chrome) instead of cold generic grey.
- **Floating island chrome**: Rather than heavy full-width toolbars bolted to viewport edges, desktop tools, top controls, inspector, and bottom HUD float as crisp elevated islands with generous breathing room and subtle dot-grid canvas visibility around them.
- **Zero Unicode glyphs**: Every tool, action, and status icon uses a bespoke inline SVG on a consistent `24×24` grid with `1.75px` stroke weight and rounded caps/joins.
- **Mobile-first thumb-zone ergonomics**: On Chrome-on-iOS (390×844), primary creation and recovery actions — especially **Undo and Redo** — live permanently in the lower thumb zone with `44×44px` touch targets, never buried behind gestures or menus.

---

## 2. Color Tokens & Verified WCAG Contrast

All text pairs exceed **WCAG AA (≥ 4.5:1)** and interactive UI control boundaries exceed **≥ 3.0:1**. Ratios below were programmatically verified against the exact hex tokens.

### Light Theme (`data-theme="light"`)

| Token | Hex / Value | Role | Verified Contrast |
|---|---|---|---|
| `--canvas-bg` | `#F8F7F4` | Infinite canvas surface (dot grid `#E4E2DC`) | — |
| `--surface` | `#FFFFFF` | Floating rails, cards, inspector, modals | — |
| `--surface-subtle` | `#F2F0EB` | Input wells, secondary pills, table headers | — |
| `--surface-hover` | `#EBE8E1` | Hover fill for ghost/icon buttons | — |
| `--border` | `#E3E0D8` | Hairline chrome dividers & card borders | — |
| `--border-strong` | `#858178` | High-emphasis control outlines & handles | **3.88:1** on `#FFFFFF` |
| `--fg` | `#18181B` | Primary text & canvas ink | **17.72:1** on `#FFFFFF` · **16.54:1** on `#F8F7F4` |
| `--fg-muted` | `#52504A` | Secondary labels, descriptions, metadata | **8.06:1** on `#FFFFFF` · **7.08:1** on `#F2F0EB` |
| `--fg-dim` | `#625F57` | Tertiary hints, shortcuts, timestamps | **6.36:1** on `#FFFFFF` · **5.60:1** on `#F2F0EB` |
| `--accent` | `#3B48E8` | Primary CTA, active tool, focus ring | **6.41:1** on `#FFFFFF` · **5.62:1** on `#F2F0EB` |
| `--accent-hover` | `#303CC9` | Accent hover state | **7.98:1** with `#FFFFFF` |
| `--accent-fg` | `#FFFFFF` | Text/icons on `--accent` | **6.41:1** on `#3B48E8` |
| `--accent-soft` | `rgba(59, 72, 232, 0.10)` | Active chip / selected row wash | — |
| `--ok` / `--ok-bg` | `#157F3D` / `#ECFDF3` | Connected, synced, active link | **5.08:1** on `#FFFFFF` · **4.82:1** on `#ECFDF3` |
| `--warn` / `--warn-bg` | `#B45309` / `#FFFBEB` | Reconnecting, pending invite | **5.02:1** on `#FFFFFF` · **4.84:1** on `#FFFBEB` |
| `--bad` / `--bad-bg` | `#C81E1E` / `#FEF2F2` | Offline, revoke, destructive delete | **5.74:1** on `#FFFFFF` · **5.24:1** on `#FEF2F2` |

### Dark Theme (`data-theme="dark"`)

| Token | Hex / Value | Role | Verified Contrast |
|---|---|---|---|
| `--canvas-bg` | `#111113` | Infinite canvas surface (dot grid `#242429`) | — |
| `--surface` | `#1A1A1E` | Floating rails, cards, inspector, modals | — |
| `--surface-subtle` | `#232328` | Input wells, secondary pills, table headers | — |
| `--surface-hover` | `#2C2C33` | Hover fill for ghost/icon buttons | — |
| `--border` | `#2E2E36` | Hairline chrome dividers & card borders | — |
| `--border-strong` | `#6D6D7A` | High-emphasis control outlines & handles | **3.40:1** on `#1A1A1E` |
| `--fg` | `#F4F4F5` | Primary text & canvas ink | **15.78:1** on `#1A1A1E` · **17.16:1** on `#111113` |
| `--fg-muted` | `#A8A8B3` | Secondary labels, descriptions, metadata | **7.37:1** on `#1A1A1E` · **6.64:1** on `#232328` |
| `--fg-dim` | `#91919E` | Tertiary hints, shortcuts, timestamps | **5.57:1** on `#1A1A1E` · **5.03:1** on `#232328` |
| `--accent` | `#818CF8` | Primary CTA, active tool, focus ring | **5.82:1** on `#1A1A1E` · **5.24:1** on `#232328` |
| `--accent-hover` | `#96A0FA` | Accent hover state | **7.86:1** with `#0E0F1A` |
| `--accent-fg` | `#0E0F1A` | Text/icons on `--accent` | **6.39:1** on `#818CF8` |
| `--accent-soft` | `rgba(129, 140, 248, 0.14)` | Active chip / selected row wash | — |
| `--ok` / `--ok-bg` | `#4ADE80` / `rgba(74, 222, 128, 0.14)` | Connected, synced, active link | **9.96:1** on `#1A1A1E` |
| `--warn` / `--warn-bg` | `#FBBF24` / `rgba(251, 191, 36, 0.14)` | Reconnecting, pending invite | **10.39:1** on `#1A1A1E` |
| `--bad` / `--bad-bg` | `#F87171` / `rgba(248, 113, 113, 0.14)` | Offline, revoke, destructive delete | **6.27:1** on `#1A1A1E` |

### Collaborator Identity Palette (Both Themes)

| User | Hex | Role |
|---|---|---|
| Maya | `#D946EF` / `#C026D3` | Cursor, avatar ring, comment pin |
| Dev | `#0891B2` | Cursor, avatar ring, comment pin |
| Priya | `#EA580C` | Cursor, avatar ring, comment pin |
| Sam | `#16A34A` | Cursor, avatar ring, comment pin |

---

## 3. Typography, Elevation, Radii & Spacing

### Typography
- **UI Sans**: `-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif`
- **Mono**: `ui-monospace, "SF Mono", Menlo, Consolas, monospace` (Hex/RGB/HSL values, zoom percentages, keyboard shortcuts, audit timestamps)
- **Scale**:
  - `22px / 600` (`-0.02em`): Dashboard page titles
  - `16px / 600` (`-0.01em`): Modal titles, bottom-sheet headers, and **all mobile text inputs** (prevents iOS Safari/Chrome focus auto-zoom)
  - `14px / 600`: Board title in top bar, card titles
  - `13px / 500`: Primary UI controls, buttons, body text, comments
  - `12px / 500`: Metadata, status pills, inspector labels, audit timestamps
  - `11px / 600`: Section eyebrows (`0.05em` uppercase), badges, keyboard shortcut caps
- **Tabular numerals**: `font-variant-numeric: tabular-nums` on zoom %, viewer counts, RGB/HSL/Opacity values, and timestamps.

### Elevation & Shadows
- **Light**:
  - `--shadow-sm`: `0 1px 2px rgba(24, 24, 27, 0.05), 0 1px 3px rgba(24, 24, 27, 0.06)` (cards, pills)
  - `--shadow-md`: `0 4px 16px rgba(24, 24, 27, 0.08), 0 1px 3px rgba(24, 24, 27, 0.06)` (floating tool rail, inspector, bottom dock)
  - `--shadow-lg`: `0 16px 40px rgba(24, 24, 27, 0.14), 0 2px 6px rgba(24, 24, 27, 0.08)` (modals, popovers, bottom sheets)
- **Dark**:
  - `--shadow-sm`: `0 1px 2px rgba(0, 0, 0, 0.35)`
  - `--shadow-md`: `0 6px 20px rgba(0, 0, 0, 0.48), 0 0 0 1px rgba(255, 255, 255, 0.04)`
  - `--shadow-lg`: `0 20px 48px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.06)`

### Radii & Spacing
- **Radii**: `6px` (micro chips, kbd), `8px` (buttons, inputs, swatches), `12px` (tool rail, floating HUD clusters, cards), `16px` (inspector, modals, mobile dock), `20px` (mobile bottom sheet top corners), `999px` (pills, avatars).
- **Spacing**: `4px` base grid (`4, 6, 8, 12, 16, 20, 24`). Floating desktop islands sit `12px` inset from viewport edges.

---

## 4. Custom SVG Iconography Rules

Unicode symbols (`▭`, `◇`, `✎`, `↺`) are completely retired. Every icon in Plenary follows one strict craft specification:

- **ViewBox**: `viewBox="0 0 24 24"` rendered at `18px` (compact), `20px` (default tool rail & mobile dock), or `16px` (inline button/badge).
- **Stroke**: `stroke="currentColor"`, `stroke-width="1.75"`, `stroke-linecap="round"`, `stroke-linejoin="round"`, `fill="none"`.
- **Optical balance**: Geometric primitives stay within a `3px–21px` safe area so rectangles, diamonds, circles, arrows, and pen nibs share identical visual weight.
- **Complete Tool Set**: Select (pointer), Hand (pan), Rectangle, Diamond, Ellipse, Arrow, Pen/Freehand, Text (`T` serifless path), Sticky Note (folded corner), Frame (`#` crop marks), Comment (speech pin), Eraser, Undo (curved counter-clockwise arrow), Redo (curved clockwise arrow), Eyedropper, Share, Sun/Moon Theme, Duplicate, Trash, Copy, Check, Revoke/Link.

---

## 5. Surface Architecture

### 5.1 Desktop Canvas (`docs/design/mock-desktop.html`)
- **Top Floating Clusters**:
  - **Top-Left Island**: Plenary mark + `Boards` breadcrumb link + `/` + editable board title (`Q3 Sync Architecture`).
  - **Top-Right Island**: Overlapping collaborator avatars + `4 viewing` counter, sleek connection status pill (`Connected` with emerald dot), prominent `--accent` **Share** button, and Theme toggle.
- **Left Floating Tool Rail**: Vertical pill (`48px` wide) centered vertically on the left edge, grouped into Navigation (Select, Hand), Primitives (Rect, Diamond, Ellipse, Arrow), Freeform (Pen, Text, Sticky Note, Frame), and Annotate (Comment, Eraser), with subtle `1px` dividers and hover tooltips showing tool name + shortcut key.
- **Right Floating Inspector (`272px`)**:
  - Contextual to selection (or active tool defaults).
  - **Custom Color Picker**: Stroke / Fill target toggle, quick studio swatches, interactive **2D Saturation/Lightness field**, **Hue spectrum slider**, **Opacity checkerboard slider**, **Hex / RGB / HSL** mode tabs with editable inputs, **Eyedropper** button, and **Saved Custom Swatches** row with `+` save trigger.
  - Stroke weight (`1.5px / 2px / 3px`), Corner style (`Sharp / Rounded`), and layer actions (Duplicate, Lock, Delete).
- **Bottom-Left Cluster**: Combined floating pill with **Undo** (`⌘Z`), **Redo** (`⇧⌘Z`), divider, **Zoom Out**, **Zoom %** (`100%`, click to reset), **Zoom In**, and **Fit to Screen**.
- **Comment Pin & Thread Drawer**: Numbered teardrop pins anchored on canvas shapes; clicking opens a crisp floating thread popover with avatar, timestamp, replies, **Resolve** toggle, and reply composer.

### 5.2 Phone / Chrome-on-iOS Canvas (`docs/design/mock-phone.html`)
Designed specifically for `390×844` portrait mobile viewports (Chrome on iOS with bottom URL bar and `env(safe-area-inset-*)` cutouts):

- **Safe-Area & Viewport Discipline**:
  - Root container uses `100dvh` / `--vv-height` so Chrome's dynamic address bar and the iOS soft keyboard never clip bottom controls.
  - Top bar respects `env(safe-area-inset-top)`; bottom dock respects `env(safe-area-inset-bottom)`.
  - Every interactive touch target is **≥ 44×44px**.
  - All `<input>` and `<textarea>` elements use **`font-size: 16px`** to prevent iOS auto-zoom on focus.
- **Compact Top Bar (`48px` content height)**:
  - Left: Back chevron to Boards (`44×44px`) + truncated board title + live emerald status dot.
  - Right: Compact **Share** button + **More (`⋯`)** menu (Theme, Export, Board Info).
- **First-Class Lower Thumb Zone (Always Visible)**:
  - **Undo / Redo Pill** anchored bottom-left directly above the bottom dock (`bottom: calc(76px + env(safe-area-inset-bottom))`). Two full `44×44px` tactile buttons with crisp SVG arrows and clear disabled state. Never hidden behind two-finger taps or overflow menus.
  - **Zoom / Fit Pill** anchored bottom-right on the same row (`100%` tap-to-fit), balancing the thumb zone symmetrically.
  - In **Viewer Mode**, editing tools & Undo/Redo cleanly yield to a compact `Read-only · Request edit` pill while keeping pan/zoom and Comments accessible.
- **Contextual Selection Action Pill**:
  - When a shape is selected, a sleek floating pill appears cleanly near the selection (or centered above the thumb row) offering one-tap **Color** (live swatch dot → opens Style sheet), **Duplicate**, and **Delete** (`44px` targets).
- **Floating Bottom Tool Dock**:
  - 6 crisp `44×44px` custom SVG tools: **Select**, **Pen**, **Shapes** (opens shape picker), **Text**, **Note**, and **Style / Comments** (opens bottom sheet).
- **Swipe-to-Dismiss Bottom Sheet**:
  - Rounded `20px` top corners, `44px`-tall grab handle hit target, segmented tabs (**Style**, **Notes**, **Comments**), containing the touch-friendly Custom Color Picker (2D SL pad, Hue + Opacity sliders, `16px` Hex input, saved swatches), sticky notes list, and comment threads.

### 5.3 Home / Admin Dashboard + Share & Audit (`docs/design/mock-admin.html`)
- **Workspace Header**: Plenary SVG logomark, workspace selector (`Omni Studio`), instant search input, Light/Dark toggle, user avatar, and prominent **+ New Board** CTA.
- **Boards Grid / List**:
  - Filter tabs (`All Boards`, `Owned by me`, `Shared with me`) + Grid/List toggle.
  - Cards feature bespoke theme-aware **SVG board preview thumbnails**, title, role badge (`Owner`, `Editor`, `Viewer`), collaborator avatar stack, relative last-active timestamp, and quick **Share** & **Open** actions.
- **New Board Modal**: Board name, visual SVG template selector (Blank, Architecture, User Flow, Retro), default visibility toggle, Create CTA.
- **Share & Access Modal**:
  - **Share Links**: Role badge (`Can edit` / `Can view`), expiry/visit count, one-tap **Copy** (instant checkmark confirmation) and **Revoke** actions, plus `+ Create link`.
  - **Email Invites**: Email input + role selector + `Send invite`.
  - **Member Grants**: Member rows with role dropdown (`Owner`, `Editor`, `Viewer`) and remove action.
- **Activity / Audit Log**:
  - Event-type filter pills (`All`, `Board edits`, `Access & Links`, `Role changes`) + search.
  - Day-grouped timeline (`Today`, `Yesterday`) with custom SVG event icons, actor avatars, clear human-readable summaries, board badge, and tabular timestamps.
