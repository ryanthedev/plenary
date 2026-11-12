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
  // Newest first (updated desc; equal `updated` keep their order), only the first `limit` built: a bounded heap,
  // O(n log limit), never a sort of every note (p7-perf: 50k notes).
  const { top, total } = newest(elements, limit);
  const want = new Set(top.map(e => e.id)), labels = new Map();
  for (const e of elements) if (e && !e.isDeleted && isLabel(e) && want.has(e.containerId)) labels.set(e.containerId, e.text);
  const writer = canWrite(role, "notes"), mod = canModerate(role);
  const rows = top.map(e => {
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
  return { rows, total, more: Math.max(0, total - limit) };
}

/** How many notes the drawer would list (live, labels not counted): one pass, no allocation. */
export function notesCount(elements) {
  let n = 0;
  for (const e of elements) if (e && !e.isDeleted && !isLabel(e)) n++;
  return n;
}

/** The `limit` newest live non-label notes, in the order a stable sort by `updated` desc gives, and how many there are. */
function newest(elements, limit) {
  // A min-heap in typed arrays (no allocation per note), "worse" on top: lower updated, or equal and a later index.
  const k = Math.max(0, limit), U = new Float64Array(k), I = new Int32Array(k), E = new Array(k);
  let size = 0, total = 0;
  const worse = (a, b) => U[a] < U[b] || (U[a] === U[b] && I[a] > I[b]);
  const swap = (a, b) => { const u = U[a]; U[a] = U[b]; U[b] = u; const i = I[a]; I[a] = I[b]; I[b] = i; const e = E[a]; E[a] = E[b]; E[b] = e; };
  for (const e of elements) {
    if (!e || e.isDeleted || isLabel(e)) continue;
    const u = e.updated ?? 0, idx = total++;
    if (!k) continue;
    if (size < k) {
      let i = size++; U[i] = u; I[i] = idx; E[i] = e;
      while (i) { const p = (i - 1) >> 1; if (!worse(i, p)) break; swap(i, p); i = p; }
    } else if (u > U[0]) {     // equal `updated` never displaces: the earlier note wins (stable order)
      U[0] = u; I[0] = idx; E[0] = e;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < size && worse(l, m)) m = l;
        if (r < size && worse(r, m)) m = r;
        if (m === i) break; swap(i, m); i = m;
      }
    }
  }
  const order = Array.from({ length: size }, (_, i) => i).sort((a, b) => U[b] - U[a] || I[a] - I[b]);
  return { top: order.map(i => E[i]), total };
}
