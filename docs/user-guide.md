# Plenary User Guide

Welcome to **Plenary** — a collaborative infinite-canvas whiteboard for visual thinking, architecture diagrams, reviews, and live presentations.

---

## Contents

1. [Getting Started & Home](#1-getting-started--home)
2. [Sharing, Access Control & Roles](#2-sharing-access-control--roles)
3. [Drawing, Diagrams, Media & Libraries](#3-drawing-diagrams-media--libraries)
4. [Live Collaboration, Comments & Notes](#4-live-collaboration-comments--notes)
5. [Animation, Frames, Views & Present Mode](#5-animation-frames-views--present-mode)
6. [Import & Export](#6-import--export)
7. [Help & Keyboard Shortcuts](#7-help--keyboard-shortcuts)

---

## 1. Getting Started & Home

When you sign in to Plenary without a specific board link, you land on **Home**.

### Home Header & Navigation

- **Header bar:**
  - `☰` (**Open navigation**): toggles the navigation sidebar (especially useful on narrow viewports).
  - **Plenary** logo and **organization badge**: shows your active Workspace.
  - **Search** (`Search boards and Spaces`, shortcut `/` or `⌘K` / `Ctrl+K`): searches across boards and Spaces (1–100 characters; press `Escape` inside the search box to clear).
  - **Theme toggle**: switches between **Light** and **Dark** appearance.
  - **Help button**: opens the Help & Shortcuts modal (`?`). *(Introduced with the in-app Help modal.)*
  - **User badge** and **Sign out**.
- **Sidebar views:**
  - **Home** (shows **Recent**, **Starred**, and **Shared with me**; guests see **Recent**, **Your boards**, and **Shared with me**). On mobile, switch between **Recent**, **Starred**, and **Shared** tabs.
  - **Starred** (hidden for guest accounts) and **Shared with me** with item counts.
  - **Teams** and **Trash** links.

### Creating Boards & Starter Templates

Click **＋ New board** (available to workspace members) or pick one of the cards under **Start from a template**:

| Template | Description |
| --- | --- |
| **Blank Board** | Start an open canvas |
| **Plenary Interactive Tour** | 4-frame guided tour with views, layers, animations & link cards |
| **System Architecture** | Multi-tier animated flow with progressive-reveal layers |
| **Presentation Deck** | 3 clean 16:9 slides with Named Views for Presentation Mode |
| **Team Retro** | 3-column framed retro board with starter sticky notes |

### Personal Space, Shared Spaces & Areas

Plenary organizes boards into two levels:

- **Personal Space (`◐`)** — tagged **Personal · only you** (*"Only you can see what's here until you share it."*). Cannot be moved to Trash.
- **Shared Spaces (`▢`)** — tagged **Space**, used for team or project collections of boards. Ungrouped spaces appear under **Other spaces**.
- **Areas** — tagged **Area** (referred to as `group` in backend URLs `?group=<id>`). Areas group multiple Shared Spaces together under one department or initiative.
- Create them from the **Spaces** sidebar section using **New space** (`＋`) or **New area** (`＋`, when permitted).
- Use a Space's **Space options** menu (`Rename`, `General access…`, `Move to Trash`), an Area's **Area options** menu (`Rename`, `General access…`) alongside the Area header's **Members** and **＋ New space** buttons, or a board card's overflow menu — on a **Space** page (`Open`, `Who has access`, `Move to…`, `Rename`, `Move to Trash`), or on **Home** (`Move to…` in `⋯`, plus `Open board`, `Star`/`Unstar board`, `Copy board link`, and `Move to…` in the mobile card actions sheet).

### Moving Boards Between Spaces (`Move to…`)

Open **Move to…** from a board card's overflow menu or the Board menu (`Collaborate` → `Move to…`):

- **Direct grants, invites and links travel with the board, and its address does not change.**
- Pick a destination Space from the **Move to** list. Plenary computes a live access diff showing who **Gains access**, **Keeps access**, or **Loses access**, along with counts of invites and links that continue working.
- After moving, an Undo toast lets you revert the move immediately.

### Trash & 30-Day Recovery

- Moving a board or Shared Space to Trash keeps it for **30 days** before automatic purge (*"Boards stay here for 30 days. Restore brings back its access, invites and links."*).
- Boards trashed along with a parent Space restore automatically when the Space is restored.
- Visiting the URL of a trashed board shows **This board is in Trash**, who trashed it, days remaining, and a **Restore** button (restoring an independently trashed board whose parent Space is still in Trash places it in your Personal Space unless doing so would escalate your role).

### Version History

Open **Board menu → Version history…** (or **More → Versions** on mobile) to view snapshots for the current board:

- Presenters (**Owner** / **Editor**) can enter a label in **Snapshot name…** and click **Save snapshot**, **Restore** a previous snapshot, or **Delete** one.
- Limits: up to **50** saved snapshots per board, **2 MB** maximum per snapshot, and **120** characters per label.
- Restoring a snapshot atomically restores elements, embedded files, layers, saved views, animation timeline, and grid state.

### Workspace Admin & Teams

Workspace admins see a collapsible **Workspace Admin** section in the Home sidebar:

- **Members**: view and manage **Workspace members**.
- **Organization access**: manage org-wide access policy and roles.
- **Roles**: create and edit custom roles.
- **Audit log**: inspect workspace audit events.
- **Offboard a member**: reassign a departing member's solely owned Areas/Spaces and hand over or archive their Personal Space before removing them.
- **Teams**: manage member groups used in direct grants on Areas, Spaces, and boards.

*(External guest users without a home Workspace see a **Create your own Workspace** card instead of Workspace Admin.)*

---

## 2. Sharing, Access Control & Roles

### The 5-Tier Access Ladder & 3 Canvas UI Modes

Plenary separates what you can edit (**Owner**, **Editor**, **Annotator**, **Commenter**, **Viewer**) into three streamlined canvas interfaces:

| Access Role | Canvas UI Mode | Capabilities |
| --- | --- | --- |
| **Owner** / **Editor** | **Presenter** | Full drawing tools (all 12 core tools + Image, Sticky Note, Highlighter), side panel/ribbon, Draw/Animate/Present modes, timeline, Mermaid/Swimlane/Table/Embed, Export, Grid, Lock Audience, Version History, and comments |
| **Annotator** | **Annotator** | `Select`, `Hand`, `Arrow`, `Pen`, `Text`, `Eraser`, `Image`, `Sticky Note`, and `Highlighter` writing to the `notes` stream (edit/delete own notes only), plus Properties panel for own notes and comments |
| **Commenter** | **Viewer** | `Hand` pan, zoom/fit, Frames/Saved Views navigation, reads notes, and can create, reply to, resolve/reopen, and react in comment threads (`records`) |
| **Viewer** | **Viewer** | `Hand` pan, zoom/fit, Frames/Saved Views navigation, reads notes and comments (read-only across all streams) |

### Share Dialog (`Share board`)

Users with share permission can open **Share board** from the top bar, Board menu → `Collaborate` → `Share board`, or Mobile `More` → `Share`:

- **Quick actions:** **Copy board link** (and **Share…** where the browser supports native sharing).
- **Invite people:**
  - Enter an email (`name@company.com`), choose a role (**Viewer**, **Commenter**, **Annotator**, or **Editor**), and pick an expiry (**7 days**, **30 days** default, **90 days**, or **Never**), then click **Invite**.
  - Addresses outside your organization's domains are automatically tagged **Guest** (*"Guest · outside your organization. Guests can be given up to Editor on this board only; they sign in with that Google account."*).
  - Plenary displays **"Nothing is emailed"** — copy and send the link to your invitee directly. Existing invites can be revoked via **Revoke**.
- **Link access:**
  - Choose a role and expiry (**1 day**, **7 days** default, **30 days**, or **Never**), click **Create link**, then **Copy link** (or **Revoke** later). Anyone who signs in with that link redeems up to the chosen role.
  - Up to 200 recent invites and links are listed; click **Change who has access on the Access page** for Space/Area/direct grants.

> **Note:** Share-link passcodes and download restrictions are supported in the server API and Agent CLI, and are not exposed as inputs in the web Share dialog.

### Access Page, Access Explanation & Access Requests

- **Access page (`Who has access` / `General access…`):**
  - **Add people or teams:** search your organization directory to add **Direct grants** for individuals or Teams.
  - **General access:** set default scope access to **Everyone can view**, **Everyone can comment**, **Everyone can annotate**, **Everyone can edit**, or **Only people added**.
  - **Access requests:** owners can grant or **Dismiss** pending requests.
- **View-only explanation & requesting access:**
  - On a read-only board, click the **View only** status pill in the top bar to see where your current role comes from (e.g., `Viewer via ...`) and click **Ask for access** to notify owners (24-hour cooldown if dismissed).

### Organization Admin, Content Tiers & Custom Roles

- **Organization admin:** manages members, teams, roles, org access, audit logs, and offboarding — **has no board content access by default** and cannot open private boards or personal spaces unless explicitly granted.
- **Content admin:** can open and edit any board in shared Spaces and Areas.
- **Content admin (personal):** can also open, move, trash, restore, and hand over boards in personal Spaces.
- **Custom roles:** admins can duplicate an existing role on the **Roles** page, configure board access and management permissions they hold, and save (changes affecting more than 10 places or 50 people prompt a confirmation check).

---

## 3. Drawing, Diagrams, Media & Libraries

### Core Tools, Sticky Notes & Highlighter

| Tool | Shortcut | Notes |
| --- | --- | --- |
| Select | `V` or `1` | Select, marquee-select, move, resize, rotate (`Shift` snaps 15°) |
| Hand (pan) | `H` | Pan canvas (or hold `Space` + drag, or middle-mouse drag) |
| Rectangle | `R` or `2` | Click for default size or drag; hold `Shift` for square |
| Diamond | `D` or `3` | Hold `Shift` for equal width/height |
| Ellipse | `O` or `4` | Hold `Shift` for circle |
| Arrow | `A` or `5` | Snaps to shape ports/perimeters; hold `⌘`/`Ctrl` to bypass snap |
| Line | `L` or `6` | Drag for segment, or click to add polyline points (`Enter`/`Esc` or double-click finishes) |
| Pen (Freedraw) | `P` or `7` | Freehand stroke; captures Apple Pencil pressure |
| Text | `T` or `8` | Click to type; press `Esc` or click outside to commit |
| Eraser | `E` or `0` | Drag over elements to erase on release |
| Frame | `F` | Container/slide frame for organizing & presenting |
| Laser pointer | `K` | Presenters only; temporary fading pointer trail |
| Sticky note | `N` | Drops/draws a sticky note on the `notes` stream (`#ffec99` default) |
| Highlighter | `M` | Translucent marker stroke on the `notes` stream (`#fab005`, width `16`, opacity `40`) |
| Keep tool active (lock) | `Q` | Keeps the current drawing tool selected after finishing a shape |

Double-click any shape or arrow to add or edit an attached text label (or press `Enter` with a shape selected).

### Style, Arrange & Canvas Shortcuts

*(Customizable actions can be rebound in Settings → Keybindings.)*

| Action | Default Shortcut |
| --- | --- |
| Undo / Redo | `⌘Z` / `⌘⇧Z` or `⌘Y` |
| Copy / Cut / Paste / Duplicate | `⌘C` / `⌘X` / `⌘V` / `⌘D` (or `Alt`-drag) |
| Select all / Delete selection | `⌘A` / `Backspace` or `Delete` |
| Group / Ungroup | `⌘G` / `⌘⇧G` |
| Lock / Unlock selection | `⌘⇧L` |
| Bring forward / Send backward | `]` / `[` (when elements are selected) |
| Bring to front / Send to back | `⌘]` / `⌘[` |
| Cycle stroke color / fill color | `C` / `B` |
| Cycle stroke style / width | `S` / `W` |
| Toggle sketch roughness | `G` |
| Increase / decrease font size | `=` / `-` |
| Rotate −15° / +15° | `<` (`⇧,`) / `>` (`⇧.`) |
| Align Left / Right / Top / Bottom | `⌥A` / `⌥D` / `⌥W` / `⌥S` |
| Align Center Horiz. / Vert. | `⌥H` / `⌥V` |
| Distribute Horiz. / Vert. | `⇧H` / `⇧V` |
| Nudge selection | Arrow keys (`2px` or grid step; `⇧`+Arrow = `20px`) |
| Zoom in / Zoom out / Reset 100% | `⌘=` / `⌘-` / `⌘0` |
| Zoom to fit board / fit selection | `⇧1` / `⇧2` |
| Toggle snap to grid | `⌘'` |
| Toggle side panel / ribbon | `I` |
| Export board | `⌘⇧E` |
| Settings & keybindings | `⌘,` |

*(On Windows/Linux, substitute `Ctrl` for `⌘` and `Alt` for `⌥`.)*

### Mermaid Flowcharts, Swimlanes & Tables

- **Mermaid (`Board menu → Insert Mermaid`, topbar icon, or paste Mermaid text directly):**
  - Supports Mermaid **flowcharts** (`graph` / `flowchart` with `TD`, `TB`, `BT`, `LR`, or `RL`).
  - Converts boxes, rounded nodes, stadiums, subroutines, cylinders/DBs, circles, diamonds, hexagons, and flags into native editable shapes, `subgraph` blocks into Frames, and edges into straight or elbow arrows. *(Directives such as `classDef`, `class`, `style`, `click`, `linkStyle`, and `direction` are ignored.)*
- **Swimlane (`Board menu → Insert swimlane`):** inserts a 3-lane diagram layout.
- **Table (`Board menu → Insert table`):** inserts a `3×3` grid table.

### Embeds & Rich Link Cards

- **Embed URL (`Board menu → Embed URL…` or mobile `More → Embed / URL`):**
  - Paste HTTPS URLs for YouTube videos, direct video (`.mp4`, `.webm`, `.mov`), direct images (`.png`, `.jpg`, `.webp`, `.gif`), Figma files/prototypes, Google Docs/Sheets/Slides, public Notion pages, or `.pdf` files (`#page=N`).
- **Rich Link Cards:**
  - Paste an HTTPS URL from **GitHub** (Issues, PRs, Discussions), **Linear**, **Jira** (`*.atlassian.net`), or **Azure DevOps** directly onto the canvas to create a clickable link card (`Ctrl`/`⌘`+click, click the `↗` badge, or use the HUD pill to open).

### Libraries & Icon Packs

Open the **Library** tab in the inspector/ribbon (`I`):

- Click **＋ Kubernetes pack** (8 icons: Pod, Deployment, Service, Ingress, ConfigMap, Secret, Node, PersistentVolume) or **＋ Cloud pack** (8 icons: Load Balancer, API Gateway, Serverless Function, Database, Message Queue, Object Storage, Cache, CDN) to load built-in packs.
- Import `.excalidrawlib` files to store reusable stencils locally in your browser (`localStorage`).

### Settings & Keybindings

Open **Board menu → Settings & keybindings…** (or press `⌘,`):

- **Preferences tab:** set default **Theme** (`Auto`, `Light`, `Dark`), **Grid** default, and **Default stroke style** (`Clean`, `Artist`, `Bold`).
- **Keybindings tab:** filter actions via `"Filter shortcuts by action or key…"`, rebind shortcuts with conflict detection against reserved/existing keys, assign **Quick-jump frame & view shortcuts (`Alt+1` – `Alt+9`)**, or **Reset to defaults**. *(Hidden on small touch phones.)*

---

## 4. Live Collaboration, Comments & Notes

### Live Presence, Cursors & Previews

- See collaborators' live cursors, selection outlines (`"<Name> selected"`), and live stroke/drag previews (`"<Name> · drawing"`).
- **Viewers** see presence (cursors, selections, previews) from **Presenters** (`Owner` / `Editor`) only.
- The top bar displays up to **5** active writer avatars on desktop (**2** on phones) plus a `+N` overflow and `<N> viewer(s)` count.
- Clicking a note, comment, frame, or comment cluster jumps smoothly to that spot on the canvas. *(Note: automated "Follow Presenter" is not currently enabled in the web UI.)*

### Emotes, Laser Pointer & Lock Audience

- **8 Emotes:** click an emote in the bottom HUD (`👍 ❤️ 😂 🎉 👏 😮 🙏 🔥`; desktop shows 6 + `✨` **More emotes** for all 8; phones show `👏` **Emotes**). Writer emotes float upward on screen; viewer emotes increment a rolling reaction counter.
- **Laser pointer (`K`):** Presenters can point dynamically across the canvas with a fading trail.
- **Lock Audience:** Presenters can toggle **Board menu → Collaborate → Lock audience edits** (or **Lock Audience** / **Locked** in the Present bar). A **Locked** badge appears in the top bar and temporarily blocks `Annotator` and `Commenter` writes. *(Note: per-user mute exists in the protocol/CLI only and has no web UI control.)*

### Connection Status Pills & Offline Handling

The status pill in the top bar reflects your live connection state:

| Status Pill | Meaning |
| --- | --- |
| **Live** | Connected and synced (may show `slow link` or `N edit(s) waiting` under congestion) |
| **View only** | Read-only access; click the pill to inspect your access source or **Ask for access** |
| **Catching up…** / **Connecting…** | Reconnecting and replaying missed operations |
| **Offline** | Disconnected; edits remain queued in memory in this tab and resend on reconnect (closing the tab triggers an unsaved-edits warning) |
| **Connection limit** | Exceeded writer connection caps (**8 tabs** per user/board or **2 connections** per tab); close an extra tab while this tab retries automatically |
| **Refused** | Session expired or access revoked; sign in again |
| **Update needed** | Client version is older than the room; reload the page |

### Notes & Spatial Comments (`board`, `notes`, `records` Streams)

Plenary isolates content into three streams so annotations and discussions never pollute the core diagram:

1. **`board` stream:** primary diagram elements (edited by `Owner` / `Editor`).
2. **`notes` stream:** Sticky Notes (`N`) and Highlighter strokes (`M`), editable by Presenters and by `Annotator`s (who can edit/delete their own notes). Open the **Notes** drawer tab (`Board menu → Collaborate → Notes`) to browse up to 200 recent notes, **jump to**, **edit**, **delete**, or compose a note centered in your view (`"Write a note… it lands at the center of your view"`).
3. **`records` stream:** spatial **Comment** pins and threaded replies (`Owner`, `Editor`, `Annotator`, and `Commenter`):
   - **Add a comment:** right-click the canvas or an element → **Add comment** (or tap **Comment** in the mobile selection sheet).
   - **Anchoring:** element-anchored pins track their target's top-right corner (showing *"Detached: its element was deleted"* if removed); point-anchored pins stay pinned to a canvas coordinate.
   - **Clustering:** boards cluster dense pins (up to 300 pins / 200 clusters); click a cluster to zoom in or list threads.
   - **Threads & Reactions:** reply (`Enter` sends, `Shift+Enter` adds a newline), **✓ Resolve** / **Reopen**, delete your own comment (or any comment as Presenter), react with any of the 8 emoji, and filter **Open** vs **Resolved** threads in the **Comments** drawer tab.

*(Note: `@mentions` autocomplete/notifications and Polls/Q&A are not wired into the live web UI.)*

---

## 5. Animation, Frames, Views & Present Mode

### Draw, Animate & Present Modes

Presenters can switch modes in the top bar:

- **Draw:** standard canvas editing.
- **Animate:** expands the multi-swimlane timeline drawer (on screens wider than `640px`) and highlights the **Animate** inspector tab.
- **Present:** hides editing chrome and shows a floating presenter bar with **Prev**, **Next Cue** / **Next Frame**, **Views**, **Laser**, **Lock Audience** / **Locked**, and **Exit Present** (`Esc`).

### Timeline, Cues, 25 Presets & 7 Easings

- **Timeline transport:** Step to start, Play/Pause (`⇧Space`), Step to end, Stop (`Esc`), **Next cue →**, scrubber (`mm:ss.t`), **Loop** toggle, and playback speed (`0.5x`, `1x`, `1.5x`, `2x`). Respects OS **Reduced motion** preferences during passive playback while still playing when explicitly triggered.
- **Timeline authoring:** **+ Animate**, **+ Cue** (up to **50** cues per board), **Cascade** (150 ms stagger), **Align**, **Tracks (N)** expand/collapse, drag clips to shift start time, resize duration (`min 100 ms`; hold `Alt` to bypass grid snapping), reorder tracks (`↑`/`↓`), and drag `◆` cue markers.
- **7 Easings:** `Linear`, `Ease Out`, `Ease In`, `Ease In-Out`, `Back Out`, `Spring`, `Bounce`.
- **25 Presets:**
  - **Entrance (15):** `Fade`, `Slide Up`, `Slide Down`, `Slide Left`, `Slide Right`, `Pop`, `Scale`, `Bounce In`, `Zoom In`, `Flip In`, `Dissolve In`, `Wipe Right`, `Wipe Left`, `Wipe Down`, `Wipe Up` *(plus legacy `Rise` / `Slide`)*
  - **Emphasis (5, loop on by default):** `Pulse`, `Wiggle`, `Shake`, `Float`, `Highlight`
  - **Path (1):** `Draw`
  - **Exit (4):** `Fade Out`, `Dissolve Out`, `Scale Out`, `Slide Out`

### Frames, Saved Views, Solo Layer & Deep Links

- **Frames (`F`):** draw named container frames, step through them in reading order (top-to-bottom, left-to-right) via `PgUp` / `PgDn` or the bottom HUD stepper, manage them in the **Frames** tab, or right-click a frame → **Fit to children**.
- **Saved Views (`⌘J`):** open **Jump to frame / view** from the topbar Views pill, `⌘J`, or the Board menu to jump to any frame or save a named view capturing the active frame and local layer visibility. When no elements are selected (or in Viewer mode), `[` and `]` step between Saved Views. Bind favorite frames/views to `⌥1`–`⌥9` in **Settings → Keybindings**.
- **Local Solo Layer:** in the **Layers** tab, click the **S** button on any layer row to solo it **for yourself only** without changing visibility for collaborators (a banner lets you click **Show all layers** to reset). *(Note: pressing the `S` key on the canvas cycles stroke style.)*
- **Deep links:** right-click an element or frame → **Copy link** to copy a direct `#frame=<id>`, `#el=<id>`, or `#view=<id>` URL.

### Touch & Trackpad Gestures

- **Trackpad / Mouse:** two-finger scroll pans; `Ctrl`/`⌘`+scroll or pinch zooms (`0.1×`–`8×`); `Space`+drag or middle-drag pans; mouse wheel scrolls the desktop horizontal control ribbon; right-click opens the context menu.
- **Touch & Mobile:**
  - Pinch to zoom and pan with momentum.
  - **2-finger quick tap** = **Undo**; **3-finger quick tap** = **Redo** (alongside persistent Undo/Redo buttons in the mobile bottom bar).
  - **Apple Pencil:** pressure-sensitive Pen strokes with automatic palm rejection (`300 ms` grace window).
  - **Long-press** an element to open the mobile selection actions sheet; drag a sheet's top grabber downward to dismiss.

---

## 6. Import & Export

### Importing Files & Clipboard Content

Import via drag-and-drop onto the canvas, paste (`⌘V`), **Board menu → Import .excalidraw**, the **Image** tool, or mobile **More → Import** / **Photo / Video**:

| Format | Limits & Behavior |
| --- | --- |
| **Excalidraw** (`.excalidraw`, `.json`, clipboard) | Up to **50 MB** and **20,000** elements; re-hashes embedded images |
| **Draw.io** (`.drawio`, `.xml`) | Up to **10 MB** and **5,000** elements |
| **Excalidraw Libraries** (`.excalidrawlib`) | Saved locally in browser storage and listed in the **Library** tab |
| **Images** (`PNG`, `JPEG`, `GIF`, `WebP`) | Up to **10 MB** per image |
| **Videos** (`MP4`, `WebM`, `QuickTime`) | Up to **50 MB** per video |
| **Mermaid** | Paste flowchart text directly onto the canvas |

*(Note: Visio, Miro, and Lucidchart parsers exist in core code but are not exposed in the web UI.)*

### Exporting (`⌘⇧E`)

Open **Board menu → Export SVG / PNG / PDF** (shortcut `⌘⇧E`) or mobile **More → Export**:

- **Formats:**
  - **SVG** (`1×` / `2×`)
  - **PNG** (`1×` / `2×`)
  - **PDF / Print** (landscape print view, 1 page per frame, with `-print.html` download fallback if popups are blocked)
  - **.excalidraw** (v2 JSON with embedded images; video elements are excluded)
- **Scope & Background:** export the **Whole board** or a single **Frame** (for SVG/PNG/PDF), with **board color** or **white** background.
- **Privacy guarantee:** **Notes, selection outlines, live cursors, and comments never appear in any export.** Exports render the `board` stream only.

---

## 7. Help & Keyboard Shortcuts

Press **`?`** anywhere on **Home** or on a **Board** (outside text inputs and open dialogs), choose **Board menu → Help & shortcuts…**, or click the **Help** button in the Home header to open the in-app **Help & Shortcuts** modal covering tools, shortcuts, touch/trackpad gestures, layers/frames/views, and roles in both Light and Dark mode. *(Shipped with the in-app Help & Shortcuts modal.)*
