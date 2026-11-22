// @ts-check
// How messages become bytes. JSON in v0; a binary codec (MessagePack, CBOR) can replace it later
// without touching rooms or replicas: they only ever see decoded objects.

/** @typedef {{ encode(msg: object): string | Uint8Array, decode(data: string | Uint8Array): object }} Codec */

/** @type {Codec} */
export const jsonCodec = {
  // An op frame starts `{"t":"op","id":"…"`, whatever order its keys were built in (§ Limits): a gateway that
  // refuses the frame before decoding it (too deep, too big to forward) reads the id from its head.
  encode: msg => JSON.stringify(msg && msg.t === "op" ? { t: msg.t, id: msg.id, ...msg } : msg),
  // Text frames only: a binary codec takes binary frames (Herdr's runtime has no TextDecoder to turn bytes into text).
  decode: data => { if (typeof data !== "string") throw new Error("the JSON codec takes text frames"); return JSON.parse(data); },
};

/**
 * The op id at the head of a raw op frame (`{"t":"op","id":"…"`), without decoding the frame, or null. For a
 * gateway that refuses a frame it won't decode, so the refusal names the op (§ Limits). Ids hold no `"` or `\`.
 */
export function frameOpId(text) {
  if (typeof text !== "string") return null;
  const m = /^\{"t":"op","id":"([^"\\]{1,256})"/.exec(text.slice(0, 300));
  return m ? m[1] : null;
}
