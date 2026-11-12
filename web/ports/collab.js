// The collab port: everything the collaboration UI (web/adapters/dom/collab/ui.js) needs from the sync layer, and
// nothing else. The collab UI never imports packages/protocol. Adapters: web/adapters/collab/sync.js (production and
// dev rooms: over web/core/session.js, whose bindEditor handles are the only protocol readers) and
// web/adapters/collab/fake.js (tests, web/collab/dev.html). Contract test: test/web/contracts/collab-contract.js.
// Names are PROTOCOL.md v1.1's unless noted; "ADDED" marks what the p7-collab brief didn't list but the UI needs.
//
// ── Who I am ────────────────────────────────────────────────────────────────────────────────────────────────
//   role      string  the protocol role from `welcome.role`: owner | editor | annotator | commenter | viewer.
//                     Never the UI's presenter/annotator/viewer: a commenter sends cursors and writes records.
//             Once seen it is never null: while a connection is re-established it is the last role the room gave,
//             so records actions still queue offline.
//   me        { user, name, client }   welcome.user, the signed-in display name, the client id of the connection
//             that carries presence (the id others' batches name me by). ONE stable object whose fields may update
//             (user arrives with welcome; rule 13 may change it): mount any time, read the fields live.
//   status    string  web/core/sync.js status names: connecting | catching-up | live | refused | stopped | limited
//             (the writer-connection cap). It is the status of the connection that carries presence and records,
//             not a merge of a tab's connections (the status pill shows the merge).
//   onStatus(fn(status, role)) → unsubscribe                                                        ADDED
//             called when `status` or `role` changes (presence clears and the emote bar disables off live).
//
// ── Presence out ────────────────────────────────────────────────────────────────────────────────────────────
//   send(kind, fields)  one presence message, sent as-is: { t: "presence", k: kind, ...fields }.
//             kind is the WIRE name: "cursor" {x, y} · "select" {stream, ids} · "laser" {pts: [[x, y, t]]} ·
//             "emote" {e}. (The brief called the second one "selection"; on the wire and here it is "select".)
//             web/core/collab/gate.js decides what to send and when (role table, rates, coalescing, the 10 s
//             repeat); the port only forwards. `preview` is not sent from here: web/core/sync.js already sends it.
//
// ── Presence in ─────────────────────────────────────────────────────────────────────────────────────────────
//   onPresence(fn(batch)) → unsubscribe   others' presence: [{ user, client, k, …fields }], k = cursor | select |
//             laser | preview | emote | leave (a `leave` inside a batch is handled like onLeave). Each message once:
//             never this tab's own (any of its connections), never twice through two connections.
//   onLeave(fn(user, client)) → unsubscribe
//   previews(stream) → [{ el, user, client }]   others' live previews on `board` or `notes` (expired ones
//             dropped; Replica.previewEntries). ADDED: the sender.
//   onHere(fn({ writers: [{ user, name, role }], writerCount, viewers })) → unsubscribe
//             always the full shape: a count-only `here` (no `writers`, PROTOCOL.md § Presence) keeps the last
//             list and updates only the counts; an explicit `writers: []` clears it.
//   onEmotes(fn({ counts: { emoji: n } })) → unsubscribe     viewers' emotes, summed per 500 ms window (`t` dropped)
//
// ── Records (comments) ──────────────────────────────────────────────────────────────────────────────────────
//   records() → { threads, pending }
//             threads: the snapshot shape (§ Records) with this client's unacknowledged actions applied on top
//             (Replica.recordsState()); pending: [{ op }] this client's unacknowledged `records` actions, oldest
//             first (ADDED: the snapshot shape alone can't say what is pending).
//   onRecords(fn()) → unsubscribe   records() may have changed (an entry, an ack, a refusal, a local action).
//             MAY be coalesced to at most one call per animation frame (the sync adapter does: p7-collabv M4), so
//             never rely on one call per change; records() is current whenever it is read. Records actions are
//             paced by the Replica's op bucket (20/s), so the UI never paces them itself.
//   thread({ id, anchor, text })   reply({ id, thread, text })   resolve({ id })   reopen({ id })
//   react({ id, emoji })   unreact({ id, emoji })   deleteComment({ id })
//             each sends one `records` op: { do: "thread" | "reply" | "resolve" | "reopen" | "delete", … } and
//             react/unreact → { do: "react", id, emoji, on: true | false }. Record ids are made by the UI (≤ 64
//             chars). The UI checks role and caps first (gate.js) and never calls an op the role can't do.
//             `edit` and `move` are in the protocol but not in this port (not built in p7-collab).
//   onRefused(fn({ op, code, message })) → unsubscribe                                              ADDED
//             a `records` op refused (rule 5: forbidden, bad-op, limit, too-large): it has left `pending`.
//
// ── Notes drawer ────────────────────────────────────────────────────────────────────────────────────────────
//   noteAuthor(id) → user | null   who made a notes element (v1 snapshot `noteAuthor`, then entries)
//   notes() → elements             the notes stream's live (not deleted) elements                   ADDED
//   element(stream, id) → { x, y, width, height } | null   null when absent or deleted; anchors follow it  ADDED
//   jumpTo?({ x, y, scale? })      optional: center the view on a world point                       ADDED
//                                  scale (optional, p7-perf): also zoom to it (a cluster click fits its members);
//                                  a port that ignores scale still centres
//   editNote?(id), deleteNote?(id) optional: the drawer shows edit/delete only when these exist     ADDED
//   destroy?()                     optional: release the port (no more callbacks, a queued records frame included);
//                                  mountCollab's destroy() calls it                                  ADDED (p7-wire2)

/** Members a port must have. Optional ones (jumpTo, editNote, deleteNote) are left out. */
export const PORT_MEMBERS = [
  "role", "me", "status", "onStatus",
  "send", "onPresence", "onLeave", "previews", "onHere", "onEmotes",
  "records", "onRecords", "onRefused", "thread", "reply", "resolve", "reopen", "react", "unreact", "deleteComment",
  "noteAuthor", "notes", "element",
];

/** The members a port lacks (empty = a complete port). Functions must be functions. */
export function missingFromPort(port) {
  const values = ["role", "me", "status"];
  return PORT_MEMBERS.filter(k => (values.includes(k) ? port?.[k] === undefined : typeof port?.[k] !== "function"));
}
