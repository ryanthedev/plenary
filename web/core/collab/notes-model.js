// The notes drawer's rows (PROTOCOL.md § Streams, `notes`): each note with its author from the v1 snapshot's
// noteAuthor. Pure. Annotators change only notes they made; owners and editors change anyone's; commenters and
// viewers read. Edit and delete show only when the port offers them (editNote / deleteNote).

import { canWrite, canModerate } from "./limits.js";

/** Only a plain hex color reaches a style: element data could hold url(…) or worse. */
export const safeColor = c => (typeof c === "string" && /^#[0-9a-f]{3,8}$/i.test(c) ? c : "#adb5bd");
const isLabel = el => el.type === "text" && !!el.containerId;
const KIND = { freedraw: "Highlight / drawing", image: "Picture", arrow: "Arrow", line: "Line" };

/**
 * @param {object[]} elements port.notes()
 * @param {{ me: { user: string }, role: string, noteAuthor: (id: string) => string | null, nameOf: (user: string) => string | null,
 *   canEdit?: boolean, canDelete?: boolean, limit?: number }} o
 */
export function notesView(elements, { me, role, noteAuthor, nameOf, canEdit = false, canDelete = false, limit = 200 }) {
  const live = elements.filter(e => e && !e.isDeleted);
  const labels = new Map(live.filter(isLabel).map(e => [e.containerId, e.text]));
  const notes = live.filter(e => !isLabel(e)).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  const writer = canWrite(role, "notes"), mod = canModerate(role);
  const rows = notes.slice(0, limit).map(e => {
    const by = noteAuthor(e.id), mine = by === me.user, may = writer && (mod || mine);
    return {
      id: e.id, text: (e.type === "text" ? e.text : labels.get(e.id)) || KIND[e.type] || "Note",
      kind: e.type === "freedraw" ? "highlight" : e.type,
      by, author: mine ? "You" : by ? (nameOf(by) ?? "Someone") : "Unknown",
      mine, color: safeColor(e.backgroundColor !== "transparent" ? e.backgroundColor : e.strokeColor),
      at: { x: e.x + (e.width ?? 0) / 2, y: e.y + (e.height ?? 0) / 2 },
      canEdit: may && canEdit, canDelete: may && canDelete, locked: writer && !may,
    };
  });
  return { rows, total: notes.length, more: Math.max(0, notes.length - limit) };
}
