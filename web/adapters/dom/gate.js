// @ts-check
// The page before the canvas: a full-page "Signing in…" while the code exchange runs (p6-hexv MEDIUM: never a blank
// page for up to ~22 s), and a signed-out screen with a sign-in link when there is no session. Part of the dom adapter;
// the composition roots call it. Text only through textContent (the notice may quote a display name).

const ID = "signin-gate";

/** Show (or replace) the gate over the page. `link`: { href, text } for the sign-in button, or null. `links`: more buttons
 *  (the dev users when the server has dev sign-in on), each { href, text }. */
export function showGate({ title, detail = null, link = null, links = [] }) {
  let el = document.getElementById(ID);
  if (!el) {
    el = document.createElement("div");
    el.id = ID; el.className = "signin-gate"; el.setAttribute("role", "status"); el.setAttribute("aria-live", "polite");
    document.body.append(el);
  }
  const box = document.createElement("div");
  const h = document.createElement("h1"); h.textContent = title; box.append(h);
  if (detail) { const p = document.createElement("p"); p.textContent = detail; box.append(p); }
  if (link) { const a = document.createElement("a"); a.className = "btn primary"; a.href = link.href; a.textContent = link.text; box.append(a); }
  if (links.length) {
    const row = document.createElement("div"); row.className = "gate-links";
    for (const l of links) { const a = document.createElement("a"); a.className = "btn"; a.href = l.href; a.textContent = l.text; row.append(a); }
    box.append(row);
  }
  el.replaceChildren(box);
  return el;
}

/** Remove the gate (the canvas is mounted). */
export function hideGate() { document.getElementById(ID)?.remove(); }
