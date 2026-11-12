// What the canvas page does for the collab UI once per animation frame (web/adapters/dom/app.js's loop), kept apart so
// it is tested without a DOM:
//   - my selection goes out as presence whenever it changed, whatever changed it (a click, Escape, select-all, a tool
//     switch, a delete), so peers never keep a ghost selection (the outbox paces it; an unchanged one is not resent);
//   - pins and the open popover are re-placed when the view moved or the board changed (they follow pan, zoom and
//     the elements they anchor to).

/**
 * @param {{ active: string, eds: Record<string, { sel: Set<string>, view: { x: number, y: number, scale: number } }>, version(): number }} S
 * @param {{ selection(stream: string, ids: string[]): boolean, layout(): void }} collab
 * @returns {() => void} call once per frame
 */
export function collabFrame(S, collab) {
  let selKey = "", layoutKey = "";
  return function tick() {
    const stream = S.active, ids = [...S.eds[stream].sel], key = `${stream}|${ids.join(",")}`;
    if (key !== selKey && collab.selection(stream, ids)) selKey = key;
    const v = S.eds.board.view, k = `${v.x}|${v.y}|${v.scale}|${S.version()}`;
    if (k !== layoutKey) { layoutKey = k; collab.layout(); }
  };
}
