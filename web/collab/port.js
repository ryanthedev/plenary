// The collab port: everything the collaboration UI (web/collab) needs from the sync layer, and nothing else.
// web/collab never imports packages/protocol; a later job (p7-wire) makes web/sync.js's bindEditor provide this
// object and passes it to mountCollab (web/collab/ui.js). web/collab/fake-port.js is a stand-in for tests and
// the dev page. Names are PROTOCOL.md v1.1's unless noted; "ADDED" marks what the p7-collab brief didn't list
// but the UI needs.
//
// ── Who I am ────────────────────────────────────────────────────────────────────────────────────────────────
//   role      string  the protocol role from `welcome.role`: owner | editor | annotator | commenter | viewer.
//                     Never the UI's presenter/annotator/viewer: a commenter sends cursors and writes records.
//   me        { user, name, client }   welcome.user, the signed-in display name, this connection's client id
//   status    string  web/sync.js status names: connecting | catching-up | live | refused | stopped
//   onStatus(fn(status, role)) → unsubscribe                                                        ADDED
//             called when `status` or `role` changes (presence clears and the emote bar disables off live).
//
// ── Presence out ────────────────────────────────────────────────────────────────────────────────────────────
//   send(kind, fields)  one presence message, sent as-is: { t: "presence", k: kind, ...fields }.
//             kind is the WIRE name: "cursor" {x, y} · "select" {stream, ids} · "laser" {pts: [[x, y, t]]} ·
//             "emote" {e}. (The brief called the second one "selection"; on the wire and here it is "select".)
//             web/collab/gate.js decides what to send and when (role table, rates, coalescing, the 10 s
//             repeat); the port only forwards. `preview` is not sent from here: web/sync.js already sends it.
//
// ── Presence in ─────────────────────────────────────────────────────────────────────────────────────────────
//   onPresence(fn(batch)) → unsubscribe   others' presence: [{ user, client, k, …fields }], k = cursor | select |
//             laser | preview | emote | leave (a `leave` inside a batch is handled like onLeave).
//   onLeave(fn(user, client)) → unsubscribe
//   previews(stream) → [{ el, user, client }]   others' live previews on `board` or `notes` (expired ones
//             dropped). ADDED: the sender, which Replica.previewsOf doesn't return today (Replica.previewBy has it).
//   onHere(fn({ writers: [{ user, name, role }], writerCount, viewers })) → unsubscribe
//   onEmotes(fn({ counts: { emoji: n } })) → unsubscribe     viewers' emotes, summed per 500 ms window
//
// ── Records (comments) ──────────────────────────────────────────────────────────────────────────────────────
//   records() → { threads, pending }
//             threads: the snapshot shape (§ Records) with this client's unacknowledged actions applied on top
//             (Replica.recordsState()); pending: [{ op }] this client's unacknowledged `records` actions, oldest
//             first (ADDED: the snapshot shape alone can't say what is pending).
//   onRecords(fn()) → unsubscribe   records() may have changed (an entry, an ack, a refusal, a local action)
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
//   jumpTo?({ x, y })              optional: center the view on a world point                       ADDED
//   editNote?(id), deleteNote?(id) optional: the drawer shows edit/delete only when these exist     ADDED

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
