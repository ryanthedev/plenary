// @ts-check
// Protocol constants the collaboration UI needs, mirrored from packages/protocol (PROTOCOL.md v1.1 § Presence,
// § Records, § Streams). web/core/collab never imports packages/protocol (only web/core/sync.js talks to the protocol), so
// these are copies; test/web/collab/limits.test.js fails if any drifts from the protocol's own values.

export const ROLES = ["owner", "editor", "annotator", "commenter", "viewer"];
const WRITERS = ["owner", "editor", "annotator", "commenter"];

/** Who may write each stream (envelope.js WRITERS). */
export const STREAM_WRITERS = {
  board: ["owner", "editor"],
  notes: ["owner", "editor", "annotator"],
  records: WRITERS,
};
export const canWrite = (role, stream) => (STREAM_WRITERS[stream] ?? []).includes(role);
/** Owners and editors delete anyone's comment and move anyone's thread (envelope.js canModerate). */
export const canModerate = role => canWrite(role, "board");

/** Per presence kind: who may send it, and how many per second per connection (presence.js PRESENCE). */
export const PRESENCE = {
  cursor: { roles: WRITERS, rate: 20 },
  select: { roles: WRITERS, rate: 5 },
  laser: { roles: ["owner", "editor"], rate: 30 },
  preview: { roles: WRITERS, rate: 20 },
  emote: { roles: ROLES, rate: 4 },
};
/** The one fixed emote set, in protocol order (presence.js EMOTES). */
export const EMOTES = ["👍", "❤️", "😂", "🎉", "👏", "😮", "🙏", "🔥"];
export const MAX_SELECT_IDS = 500, MAX_LASER_POINTS = 64, PREVIEW_TTL_MS = 5000;
export const MAX_ID_CHARS = 64;

/** § Presence: a receiver drops a (user, client) after this long silent; a sender repeats cursor/select this often. */
export const PRESENCE_SILENCE_MS = 30_000, PRESENCE_REPEAT_MS = 10_000;
/** § Presence, `here`: at most this many writers listed. */
export const HERE_MAX_WRITERS = 50;

/** § Records caps (envelope.js CAPS.records). */
export const RECORDS = { threads: 10_000, comments: 500, emoji: 20, emojiChars: 32, text: 10_000 };
