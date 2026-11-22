# Plenary Boards Home — End-to-End Customer Journeys (#119)

This map documents the 5 core customer journeys through Boards Home (`web/adapters/dom/home.js` + `web/home.css`) and verifies every entry point, primary surface, and exit point.

---

## 1. First-Time Personal / Self-Host User

- **Entry:** Signs in with Google, OIDC, or dev sign-in and lands at `/` with no `?board=` parameter.
- **Home Surface:**
  - Calm Warm Studio Paper (Light) / Obsidian Studio (Dark) layout with a single primary **`＋ New board`** button in the sidebar.
  - **"Start from a template"** horizontal strip at the top of Home (`Blank Board`, `Architecture Diagram`, `Presentation Deck`, `Retro / Sticky Notes`).
  - Welcoming empty state (`Welcome to Plenary.`) when no boards exist yet; if signed in as a personal guest without a workspace and `org` is available, shows the inline **Create your own Workspace** card.
- **Flow:**
  1. Click any template card (or **`＋ New board`**) → opens the New board dialog with the template title pre-filled and personal Space pre-selected.
  2. Submit → creates the board and navigates directly to `?board=<id>`.
  3. From the board canvas, open **Share** to invite collaborators or generate a share link.
- **Exit:** Active board canvas (`?board=<id>`) with clean back-navigation to Home (`./`).

---

## 2. Collaborator / Viewer / Guest

- **Entry:** Opens a share link (`/links/<id>`) or signs in as an external guest (`data.guest === true`) and visits `/`.
- **Home Surface:**
  - Zero admin clutter: no **Workspace Admin** section, no **`＋ New board`** / **`＋ New space`** / **`＋ New group`** buttons, no **Starred** tab, no template strip, and no Spaces tree.
  - Shows only **`Home`** and **`Shared with me`** navigation, plus `Recent`, `Your boards`, and `Shared with me` board cards (or `Nothing is shared with you yet. Open the link you were sent.`).
- **Flow:**
  1. Open any shared board card → navigates to `?board=<id>` with the granted role (`viewer`, `commenter`, `annotator`, `editor`).
  2. Return to Home via the Plenary logo or Home link.
- **Exit:** Shared board canvas (`?board=<id>`) or clean return to Home (`./`).

---

## 3. Creator / Presenter

- **Entry:** Returning workspace member landing on `/` with existing boards, Spaces, and starred items.
- **Home Surface:**
  - Rich visual board cards with theme-aware mini-canvas preview headers, subtle role pill (`owner`, `editor`, `viewer`), truncated title, and single-line metadata (`Path · role · timestamp` with `white-space: nowrap` timestamps).
  - Star toggle (`☆` / `★`) and `⋯` overflow menu (`Move to…` when `can.move` is true) positioned cleanly on each card without clipping dropdown menus.
  - Sidebar separates daily navigation (`Home`, `Starred`, `Shared with me`) from the `Spaces` section, which places compact `＋` buttons for **New space** and **New group** (when `can.createGroup`) right beside the `Spaces` label.
- **Flow:**
  1. Press `/` or `⌘K` (or `Ctrl+K`) anywhere to focus instant debounced search; press `Escape` to clear and return to Home.
  2. Filter via `Starred`, `Shared with me`, or click any Space (`?space=<id>`) / Group (`?group=<id>`) link in the sidebar.
  3. Click any board card to open in 1 click.
- **Exit:** Board canvas (`?board=<id>`), Space page (`?space=<id>`), or Group page (`?group=<id>`).

---

## 4. Org / Workspace Admin

- **Entry:** Workspace or org administrator (`isAdmin`, `can.manageAccess`, `can.manageRoles`, or workspace links `teamsHref`/`trashHref`).
- **Home Surface:**
  - Everyday creative navigation (`Home`, `Starred`, `Shared with me`, `Teams`, `Trash`, `Spaces`) stays uncluttered at the top of the sidebar.
  - Dedicated collapsible **Workspace Admin** (`<details>`) section sits directly below `Spaces` and groups strictly admin-only controls (`Members`, `Organization access`, `Roles`, `Audit log`, `Offboard a member`).
  - Automatically hidden (not rendered) for ordinary members and guests who have no admin capabilities; automatically expands when `Members` or `Audit log` is active.
- **Flow:**
  1. Expand **Workspace Admin** → open **Members** (add/remove collaborators by email) or **Audit log** (paginated workspace activity) inline, or navigate to `Teams`, `Roles`, `Organization access`, `Offboard a member`, or `Trash`.
  2. Return to daily boards via `Home` (collapsing or leaving admin out of the way).
- **Exit:** Inline admin panels (`Members`, `Audit log`), dedicated admin routes (`?teams=`, `?roles=`, `?access=`, `?offboard=`, `?trash=`), or back to `Home`.

---

## 5. Mobile User (Chrome on iOS, `<= 640px` / `pointer: coarse`)

- **Entry:** Opens Plenary on an iPhone (`390×844` Chrome on iOS) with dynamic viewport height (`100dvh`) and safe-area cutouts.
- **Home Surface:**
  - Sticky thumb-friendly header respecting `env(safe-area-inset-top)`, `left`, and `right`, with `16px` search input (prevents iOS focus auto-zoom).
  - All interactive targets (`＋ New board`, nav pills, compact `＋` Space/Group actions, **Workspace Admin** disclosure summary, template cards, star buttons, `⋯` overflow menus) enforce `>= 44×44px` minimum hit targets.
  - Horizontal scroll-snap template strip (`scroll-snap-type: x mandatory`) and clean single-column visual board card list with `env(safe-area-inset-bottom)` clearance.
- **Flow:**
  1. Tap a template card or **`＋ New board`** → bottom-sheet modal opens with `16px` title input.
  2. Tap a board card → opens the mobile canvas with thumb-zone Undo/Redo and bottom tool dock.
- **Exit:** Mobile board canvas (`?board=<id>`) or clean return to Home (`./`).
