// @ts-check
// A tiny element builder for web/collab. Names, comment text and note text are untrusted: text goes in only as
// text nodes, tags are literals in this package's code, and nothing here can set HTML.
//   h("button.tb.on", { title: "x", onclick }, "label", child, …)
const PROPS = new Set(["value", "disabled", "hidden", "checked", "placeholder", "rows"]);

export function h(tag, attrs = {}, ...kids) {
  const [name, ...cls] = tag.split(".");
  const el = document.createElement(name || "div");
  if (cls.length) el.className = cls.filter(Boolean).join(" ");
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "style") for (const [p, val] of Object.entries(v)) el.style.setProperty(p.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`), String(val));
    else if (k === "class") el.className = el.className ? `${el.className} ${v}` : String(v);
    else if (PROPS.has(k)) el[k] = v;
    else if (/^[a-z][a-z0-9-]*$/.test(k) && !k.startsWith("on")) el.setAttribute(k, v === true ? "" : String(v));
  }
  put(el, kids);
  return el;
}
function put(el, kids) {
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(typeof k === "object" && k.nodeType ? k : document.createTextNode(String(k)));
}
/** Replace an element's children (text kids become text nodes). */
export function replace(el, ...kids) { el.replaceChildren(); put(el, kids); return el; }
