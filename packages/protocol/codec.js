// How messages become bytes. JSON in v0; a binary codec (MessagePack, CBOR) can replace it later
// without touching rooms or replicas: they only ever see decoded objects.

/** @typedef {{ encode(msg: object): string | Uint8Array, decode(data: string | Uint8Array): object }} Codec */

/** @type {Codec} */
export const jsonCodec = {
  encode: msg => JSON.stringify(msg),
  // Text frames only: a binary codec takes binary frames (Herdr's runtime has no TextDecoder to turn bytes into text).
  decode: data => { if (typeof data !== "string") throw new Error("the JSON codec takes text frames"); return JSON.parse(data); },
};
