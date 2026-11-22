// @ts-check
// A tiny element builder. Board content (frame, layer, library, note text, user names) is untrusted, so
// text only ever goes in through textContent, never innerHTML.
//   h("button.tb.on", { title: "x", onclick }, "label", child, …)
export function h(tag, attrs = {}, ...kids) {
  const [name, ...cls] = tag.split(".");
  const el = document.createElement(name || "div");
  if (cls.length) el.className = cls.filter(Boolean).join(" ");
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "class") el.className += (el.className ? " " : "") + v;
    else if (k === "value" || (k in el && k !== "list" && typeof v !== "string")) el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  if (name === "button" && el.classList?.contains("tb")) {
    const label = attrs?.["aria-label"] ?? attrs?.title ?? el.textContent.trim();
    if (label) {
      el.setAttribute("aria-label", label);
      if (!attrs?.title) el.setAttribute("title", label);
    }
  }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export function replace(el, ...kids) { el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false).map(k => (k instanceof Node ? k : document.createTextNode(String(k))))); return el; }
