# Board organization: journey spec (draft for approval)

Status: design draft, 2026-11-18. No product code yet. The clickable mock is `mock.html` in this folder, and
`shots/` has one screenshot per screen. Mock screen ids appear in brackets, like [home]. Open the mock with
`open design/orgs/mock.html` and add `?s=<id>` to jump to a screen. The striped mock bar names the person you are
viewing as: Ada (a member), Priya (a Unit admin, on Roles) or Dev (Infra team, on Platform).

The model, in the user's words: *"think of it like GitHub. You can create a place to store different boards. You
can have teams who can edit or view that place. And then you can organize places into higher units. And you can
have a personal space as well."*

## 1. Nouns

There are seven nouns, each with one meaning. The UI uses no other words for these things: no workspace, project,
folder, org, tenant or company as a noun.

| Noun | One line | GitHub / GitLab analogue |
|---|---|---|
| **Unit** | The top-level container: one tenant, owning one or more Google Workspace domains. Its *kind* label says "Company" or "Enterprise". Everything below belongs to exactly one Unit. | GitHub org / enterprise |
| **Group** | A named shelf of Spaces ("Product", "Sales"). It has members and teams, and its access flows down to its Spaces. | GitLab group |
| **Space** | A place that holds boards. It sits in one Group or directly in the Unit, has members and teams, and its access flows down to its boards. | repo |
| **Personal space** | The Space every Unit member gets, named after them. It is private until they share a board from it. | your user's repos |
| **Board** | One canvas. It lives in exactly one Space, so no board is ever homeless. | a file in the repo |
| **Team** | A named set of Unit members ("Design", "Infra"). A team gets a role on the Unit, a Group, a Space or a board. | GitHub team |
| **Guest** | Someone from outside the Unit. They see only the boards they were invited to or got a link for. | outside collaborator |

**Decision: a Unit does not nest. It carries a kind label (Company or Enterprise), and an enterprise with several
Workspace domains is one Unit that owns all of them.** The reasons:

1. Today a tenant is a hard wall. Store keys, blob keys and bus subjects are all `(tenant, …)`, and "nothing a
   client sends can reach another tenant" (PROTOCOL.md § Tenancy). Nested Units would need access that crosses
   that wall.
2. What an enterprise usually wants from sub-units (one per subsidiary or department) is exactly what Groups
   give: separate members and access, under one admin.
3. If several domains map to one Unit, one person who has addresses on two domains stays one member.

The cost is that two independent companies cannot be federated under a parent. That can be added later as a
separate "Enterprise > Units" layer if a customer needs it (open question 1).

**Decision: Groups do not nest either, which gives one level (Unit > Group > Space > Board).** A whiteboard tool's
content is shallow: departments become Groups and initiatives become Spaces. Nesting is where Miro and GitLab
users get lost ("why can I see this?"), and with one level every access path is three hops at most. A Space need
not be in a Group, so a small Unit never has to make Groups at all. Nesting can be added later
(`group.parent`) without a migration.

## 2. Roles and permissions (RBAC)

**A role is a named set of permissions. The server checks permissions, never role names.**

The board ladder from today stays as the set of built-in roles at every scope:
`viewer < commenter < annotator < editor < owner`. Two built-in roles exist at Unit scope only:

- **Unit admin**: everything, everywhere.
- **Unit member**: what everyone in the Unit gets.

Built-in roles cannot be edited, except **Unit member**, which an admin can change. That is the default
everyone gets. **Custom roles are proposed for v1.** An admin makes one by duplicating a built-in role and
ticking or unticking permissions, and can then assign it at any scope. A custom role has two parts:

- **Board content**: one step of the ladder (view, comment, annotate or edit). This is what the live room sees, because a
  room still receives one ladder role per connection, as it does today.
- **Management permissions**: the ticks below, which the admin API checks (`board.create`, `members.manage` and the rest).

So a custom role never needs the room to change. Permissions:

| Permission | Means |
|---|---|
| `board.view` / `.comment` / `.annotate` / `.edit` | unchanged from today |
| `board.create` | make a board in this Space |
| `space.create` | make a Space in this Group, or at the Unit root |
| `members.manage` | assign and remove roles at this scope; create and revoke invites and links |
| `move` | take a board out of this scope (moving it in needs `board.create` at the destination) |
| `delete` | send to Trash, restore and purge |
| `transfer` | give `owner` to someone else |
| `roles.manage` | create and edit custom roles (Unit scope only) |

Built-in roles × permission, by scope:

| Scope | Role | create board | create space | manage members | move | delete | transfer |
|---|---|---|---|---|---|---|---|
| Unit | admin | anywhere | anywhere | everything, plus Teams and Roles | anywhere | anywhere | anywhere |
| Unit | member | in own personal space | **yes, at the Unit root** (editable) | Teams they made | own boards | own boards | own boards |
| Group | owner | in all its Spaces | in this Group | Group and its Spaces | out of the Group | its Spaces and boards | yes |
| Group | editor | in all its Spaces | in this Group | no | no | no | no |
| Group | viewer…annotator | no | no | no | no | no | no |
| Space | owner | yes | n/a | Space and its boards | out of the Space | Space and its boards | yes |
| Space | editor | yes | n/a | no | no | boards they created | no |
| Space | viewer…annotator | no | n/a | no | no | no | no |
| Board | owner | n/a | n/a | this board, up to editor (today's rule) | yes | yes | yes |
| Board | editor…viewer | n/a | n/a | no (today's rule) | no | no | no |

- A role on a container gives the same board role on every board inside it. For example, a Space editor is an
  editor of all of its boards.
- "Own boards" means the boards the member owns, which always includes their personal space.
- A guest holds board-scope roles only, capped at editor, as today. A guest is never on a Space, Group or Team.
- A custom role can't hold permissions above what its scope allows. For example, `roles.manage` only exists at
  Unit scope.

### How a board's effective role is resolved

The **union** of permissions from every source below applies, which for the built-in ladder means *highest
wins*. Nothing subtracts: there is no deny.

1. **Direct grant** to the user on the board. This is today's `grants` table; the creator gets `owner`.
2. **Team grants** on the board, for each Team the user is in.
3. **Grants on the board's Space**, for the user and their Teams.
4. **Grants on that Space's Group**, for the user and their Teams.
5. **General access**: the role "Everyone in Acme" gets on the board, Space or Group, for Unit members only.
   **This is today's `memberRole`, widened.** It keeps its meaning on the board and gains a twin on Spaces and
   Groups.
6. **Invite** to the user's authoritative email: unchanged (board scope, up to editor).
7. **Share link** the user redeemed: unchanged (board scope, up to editor).
8. **Unit role**: Unit admin = owner everywhere (today's tenant admin). Unit member adds only its own
   permissions.

Every answer keeps its **sources**, so the UI can always say *why* ("Editor via Infra team on Space Platform").
That is journey J10.

**A board can't be more private than its Space.** To keep a board private, put it in a private Space or in your
personal space. That is why Move shows who gains and loses access (J3).

**Defaults:**
- A personal space and its boards have General access **none**. Today `memberRole` defaults to `viewer`, which
  would expose drafts Unit-wide.
- A new Space has **viewer**; its creator can pick none.
- A new board in a Space has **none**, so it inherits from its Space.

### How this maps onto today

| Today | Becomes |
|---|---|
| tenant (`createTenant`, one domain) | **Unit** (kind: Company or Enterprise; one or more domains) |
| tenant admin | Unit admin role |
| `grants(board, user, role)` | direct board grant, unchanged |
| `memberRole` on a board | board General access: same meaning, new default for personal boards |
| invites and links (board owner or admin, up to editor) | unchanged, still board scope only |
| `POST /boards`, admin only | `board.create` on the target Space; always allowed in your own personal space |
| "only a tenant admin grants `owner`" | **Deviation:** a Space or Group owner may also grant board `owner` inside it, and a board's owner may transfer it (`transfer`) |
| the room gets one ladder role (`viewer`…`owner`) | unchanged: a custom role's *board content* step is what the room gets; its other permissions stay in the admin layer |
| last-owner invariant (board) | kept; Spaces and Groups also keep ≥1 owner (a Unit admin is the backstop, never counted) |
| no board list, rename or delete | Home, Space pages, rename in place, Trash |
| web/main.js:73 "No board in this link" when signed in without `?board=` | goes to [home] |

**Deviations from the brief's mapping:** the name is Unit (per the user), Units carry a kind label instead of
nesting, Groups have one level, and Unit member is an editable role. There are no others.

## 3. Journeys

Each step is **screen: action**. The demo data: the Unit is Acme (a Company, `acme.com`), you are Ada, the Groups
are Product and Engineering, the Spaces are Design, Q4 Planning and Platform, and the Teams are Design,
Leadership and Infra.

### J1. First sign-in, then Home
1. **Sign-in gate:** Ada signs in with Google. Her `hd`, `acme.com`, belongs to the Unit Acme.
2. **[home]:** she lands on Home, not on "No board in this link". Her personal space, "Ada's space", was made on
   her first sign-in. The sidebar shows Home, Starred, Shared with me, Ada's space, the Groups and Spaces she can
   see, and Trash.
3. **[home]:** with no recent boards, she sees the first-run empty state (§5): New board, the Spaces open to
   everyone, and Create a Space.

*Guest branch* (Gmail, or a domain with no Unit). Bo signs in and lands on [home] showing only Shared with me and
Recent. He gets no personal space and no New board, because a board belongs to a Unit. Empty state: "Nothing is
shared with you yet. Open the link you were sent."

### J2. Create a first board
1. **[home]:** Ada clicks **New board**.
2. **[new-board]:** she types the title "Offsite ideas". **Location** defaults to *Ada's space · only you*. The
   picker lists only the Spaces where she has `board.create`.
3. **[new-board]:** she clicks **Create**, and the canvas opens. The board now shows in Recent and in Ada's space.

### J3. Move a personal board into a Space
1. **[space-personal]:** Ada opens the card's **⋯** menu and clicks **Move to…**.
2. **[move]:** she picks *Product / Design*. Only the Spaces where she can create boards are listed.
3. **[move]:** an access diff appears. "Gains access: Design team (Editor), Everyone in Acme (Viewer). Keeps:
   you (Owner), 1 invite. Loses: nobody."
4. **[move]:** she clicks **Move**. Direct grants, invites and links travel with the board, and its URL doesn't
   change. An Undo toast stays for 10 s.

### J4. Create a Space and give a team edit access
1. **[home]** or **[group]:** Ada clicks **New space**.
2. **[new-space]:** she enters the name "Q4 Planning". For Group she picks *Product* (that needs Group editor) or
   *No group*. For General access she picks *Everyone in Acme can view* or *Only people added*. She clicks
   **Create**.
3. **[space]:** the Space opens empty, showing "No boards yet" and New board.
4. **[space-settings]:** she clicks **Members** in the Space header, then **Add people or teams**, and types
   "Lead". She picks *Leadership · 8* and the role **Editor**, then clicks **Add**.
5. **[space-settings]:** the row reads "Leadership · 8 members · Editor". Below it, the inherited rows
   ("via Product") are shown read-only, with a link to the Group.

### J5. Find a board next week
1. **[home]:** **Recent** comes first: the last 12 boards she opened, from every Space and from Shared with me.
2. **[home]:** clicking ☆ on any card stars it. **Starred** in the sidebar lists the starred boards.
3. **[home]:** **Search** (`/` or ⌘K) matches board titles and Space names among the boards she can open. Each
   result shows its path: *Product / Design / Roadmap*.
4. **[shared]:** **Shared with me** lists the boards given to her directly (by grant, invite, link or a team grant
   on the board) that live in Spaces she isn't a member of. This fixes Figma's gap.

### J6. Share one board with an outsider
1. **Canvas top bar:** Ada clicks **Share**.
2. **[share]:** she types `kim@partner.io`. The field tags it "Guest · outside Acme", and the role picker stops at
   Editor. She picks **Commenter** and clicks **Invite**. That creates an invite to the authoritative email, with
   a 30-day default expiry.
3. **[share]:** a row "Kim (invite pending)" appears. Under **Who else has access**, the inherited rows show
   read-only ("Design team · Editor · via Space Design").
4. **[share]:** alternatively, under **Link access** she picks *Anyone with the link*, a role (up to Editor) and
   an expiry, then clicks **Copy link**. Anyone using the link still signs in with Google.
5. **[share]:** ✕ revokes an invite or link. Access ends within about 60 s, as with today's re-check.

### J7. Leaver offboarding
Content belongs to Spaces, not people, so a leaver only affects their **personal space** and **whatever they
were the only owner of**.
1. **[admin-offboard]** (spec only): an admin removes Sam (later, SCIM does it). The screen lists what Sam alone
   owns: his personal space (14 boards), the Space "Field notes" and 2 boards.
2. **[admin-offboard]:** each item is assigned to **Sam's manager** if the directory knows them, otherwise to the
   admin doing the removal, and can be changed per item. Nothing goes silently to "the oldest admin", the way
   Miro does it.
3. **[admin-offboard]:** Sam's personal space becomes the ordinary Space "Sam's space (archived)", owned by the
   recipient. Its board URLs and guests' access stay.
4. Sam's own grants and team memberships are removed. The invites and share links he made stay until they expire,
   now vouched for by the new owner, so guests keep access (open question 5).

### J8. Trash and restore
Trash is free on every plan, with no paywall.
1. **[space]:** Ada picks **⋯ → Move to Trash** (this needs `delete`). The toast reads "Moved to Trash · Undo".
   Opening the board's URL now shows "This board is in Trash" and, for those allowed, **Restore**.
2. **[trash]:** the list holds the boards Ada deleted plus those from the Spaces she owns. Each row shows where it
   was, who deleted it and how many of its 30 days are left.
3. **[trash]:** she clicks **Restore**, and the board goes back to its Space (or to her personal space if that
   Space is gone), along with its grants, invites and links.
4. After 30 days a board is purged. A Space in Trash takes its boards with it, and brings them back on restore.

### J9. Admin manages roles
1. **[roles]** (Unit settings, then Roles): Priya, a Unit admin, sees every role as a row: built-in ones marked
   🔒, then custom ones. Each row shows its scope range, a one-line summary and "used in N places".
2. **[roles]:** she clicks **Editor**. The detail pane shows the **permission matrix**: permissions down the side,
   scopes (Unit, Group, Space, Board) across, with ✓ wherever it applies. Built-in roles are read-only and offer
   **Duplicate**.
3. **[roles]:** she clicks **Duplicate**, names it "Facilitator" and ticks `board.edit`, `members.manage`
   (board) and `board.create`, but not `delete` or `move`. The pane names the permissions it is closest to
   ("like Editor, plus can invite"). She clicks **Save role**.
4. **[roles] → Unit member:** she can untick `space.create`. The banner then warns "212 members will no longer be
   able to create Spaces at the root. Existing Spaces are unaffected."
5. **Assigning at any scope:** the picker is the same everywhere. **[space-settings]** (Space), the Group's
   members tab (Group), **[share]** (board) and Unit settings, then Members (Unit) all have **Add people or
   teams**, then a role picker listing the built-in and custom roles valid at that scope. Each role in the picker
   carries its one-line summary.
6. Editing a custom role that is in use shows "Used in 4 places" before **Save**, and changes take
   effect within one re-check pass (about 60 s).

### J10. Member sees why they can or can't do something
1. **[space] (Platform):** Dev, a member of the Infra team, sees **New board** disabled. Hovering over it shows
   "You're a **Viewer** in Platform, via the **Infra** team. Creating boards needs Editor. Owners: Priya, Tom."
   with an **Ask for access** link that messages the owners.
2. **[access]** (the Space's **Access** tab): Dev opens **Your access**, which lists every source and what it
   grants. He gets everything any of them grants, and the source that grants the most is marked:
   - Viewer · via the Infra team · on Space Platform (**grants the most**)
   - Viewer · via Everyone in Acme · on Group Engineering
3. **[access]:** below it, **Who has access** (visible to all members) groups people by source: direct, by team,
   inherited from the Group, General access. Each row reads *name · role · from where*. Owners also get "Remove"
   and "Change role" on the rows set at this scope. Inherited rows link to where they are set.
4. **Canvas, read-only pill:** a viewer clicking the pill gets the same one-line explanation ("Viewer via Space
   Platform · Infra team").

## 4. Screens

| Id | Screen | In mock |
|---|---|---|
| home | Home: Recent, Starred, sidebar tree, Search | yes |
| shared | Shared with me | yes |
| group | Group page: its Spaces, members, New space | yes |
| space | Space page: boards grid, New board, Members, Access, ⋯ menu | yes (`?s=space&menu=Roadmap` opens ⋯) |
| space-viewer | The same Space page seen by a viewer: New board disabled, with the "why" card (J10) | yes |
| space-personal | Personal space | yes |
| space-settings | Space members and teams, General access, inherited rows | yes |
| access | Space Access tab: your access with sources, who has access and from where | yes |
| roles | Unit settings › Roles: list + role detail with permission matrix | yes (`&role=editor\|member\|facilitator`) |
| new-board | New board dialog | yes |
| new-space | New space dialog | yes |
| move | Move dialog with the access diff | yes |
| share | Board Share dialog | yes |
| trash | Trash with Restore | yes |
| home (guest) | Home with Shared with me only | spec only (J1) |
| board-in-trash | Canvas gate "This board is in Trash" | spec only |
| admin-offboard | Unit settings › reassign a leaver's sole-owned items | spec only |
| unit-members, teams | Unit settings › Members, Teams | spec only (same pattern as space-settings) |

## 5. Empty states

| Where | Copy | Action |
|---|---|---|
| Home, first run | "Welcome to Plenary. Start a board, or join a Space your team already uses." | New board · open Spaces |
| Home, guest | "Nothing is shared with you yet. Open the link you were sent." | none |
| Starred | "Star a board (☆) to keep it here." | none |
| Shared with me | "Boards people share with you directly show up here." | none |
| Personal space | "Only you can see what's here until you share it." | New board |
| Space, can create | "No boards yet." | New board |
| Space, can't create | "No boards yet. You're a Viewer here; owners can add you as an Editor." | Ask for access |
| Group, no Spaces | "No Spaces in Product yet." | New space (Group editor) |
| Search, no hits | "No boards or Spaces match "…". You only see what you can open." | none |
| Trash | "Trash is empty. Deleted boards stay here for 30 days." | none |
| Roles, no custom roles | "Built-in roles cover most needs. Duplicate one to make your own." | Duplicate |

## 6. Open questions for you

1. **Unit shape:** should a Unit carry a kind label and own several domains (my default), or should Units nest,
   with an Enterprise Unit holding Company Units that are federated across the tenant wall?
2. **Group nesting:** one level (my default), or nested like GitLab?
3. **No deny:** is it OK that a board can't be more private than its Space? The alternative is a per-board
   "restrict" switch, which brings deny rules and makes J10's explanations harder.
4. **Custom roles in v1:** yes, by duplicating a built-in role (my default), or built-ins only at first?
5. **A leaver's invites and share links:** do they stay until they expire, vouched for by the new owner (my default),
   or get revoked with the leaver, cutting off guests?
6. **Guests on Spaces:** board-only (my default, today's rule), or allow a guest on a whole Space, for example an
   agency?
