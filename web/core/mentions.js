// @ts-check
// Pure @mentions, comment thread filtering, and notification model (Issue #13).
// Zero browser globals (no window, document, Date, Math.random, Intl, console).

/**
 * @typedef {{
 *   id?: string,
 *   user?: string,
 *   handle?: string,
 *   name?: string,
 *   email?: string,
 *   role?: string,
 *   canView?: boolean,
 *   revoked?: boolean,
 *   removed?: boolean,
 * }} Participant
 */

/**
 * @typedef {Participant & { handle: string }} MentionCandidate
 */

/**
 * @typedef {{
 *   query: string,
 *   start: number,
 *   end: number,
 * }} MentionQuery
 */

/**
 * @typedef {{
 *   id?: string,
 *   by?: string,
 *   author?: string,
 *   user?: string,
 *   name?: string,
 *   at?: number,
 *   text?: string,
 *   deleted?: boolean | number,
 *   mentions?: string[],
 * }} CommentItem
 */

/**
 * @typedef {{
 *   id: string,
 *   by?: string,
 *   name?: string,
 *   at?: number,
 *   resolved?: boolean | { by?: string, name?: string, at?: number } | null,
 *   comments?: CommentItem[],
 * }} CommentThread
 */

/**
 * @typedef {string | { id?: string, user?: string, handle?: string, email?: string, name?: string } | null | undefined} UserIdentity
 */

/**
 * @typedef {Record<string, number> | Map<string, number> | null | undefined} ReadAtMap
 */

/**
 * @typedef {"all" | "mentions" | "unread" | "resolved"} ThreadFilter
 */

/**
 * @typedef {{
 *   id: string,
 *   threadId: string,
 *   commentId: string,
 *   kind: "mention" | "reply",
 *   by: string,
 *   authorName: string,
 *   text: string,
 *   at: number,
 *   unread: boolean,
 *   resolved: boolean,
 * }} NotificationItem
 */

const MAX_TOKEN_LEN = 128;
const DEFAULT_CANDIDATE_LIMIT = 8;
const DEFAULT_NOTIFICATION_LIMIT = 50;

// Matches @email or @handle preceded by start-of-string or a non-word/non-email-local boundary.
// Avoids matching email addresses like "foo@bar.com" or double-at "@@alice", and strips trailing sentence punctuation.
const MENTION_RE = /(^|[^A-Za-z0-9._%+@-])@([A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?)/g;

/**
 * ASCII-safe lexicographical compare (never uses Intl / localeCompare).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Extract unique lowercase `@handle` / `@email` tokens (without leading `@`) from text.
 * @param {string} text
 * @returns {string[]}
 */
export function parseMentions(text) {
  if (typeof text !== "string" || !text.includes("@")) return [];
  /** @type {string[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  MENTION_RE.lastIndex = 0;
  let match;
  while ((match = MENTION_RE.exec(text)) !== null) {
    const raw = match[2];
    if (!raw || raw.length > MAX_TOKEN_LEN) continue;
    const token = raw.toLowerCase();
    if (!seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

/**
 * Derive a participant's canonical handle string.
 * @param {Participant} p
 * @returns {string}
 */
function resolveHandle(p) {
  if (!p || typeof p !== "object") return "";
  if (typeof p.handle === "string" && p.handle.trim()) return p.handle.trim().replace(/^@+/, "");
  if (typeof p.user === "string" && p.user.trim()) return p.user.trim().replace(/^@+/, "");
  if (typeof p.email === "string" && p.email.includes("@")) return p.email.split("@")[0].trim();
  if (typeof p.id === "string" && p.id.trim()) return p.id.trim().replace(/^@+/, "");
  return "";
}

/**
 * Whether a participant can currently view the board.
 * @param {Participant} p
 * @returns {boolean}
 */
function canSeeBoard(p) {
  if (!p || typeof p !== "object") return false;
  if (p.canView === false || p.revoked === true || p.removed === true) return false;
  if (typeof p.role === "string" && p.role.toLowerCase() === "none") return false;
  return true;
}

/**
 * Score how well a candidate matches a lowercase prefix query. Lower is better; -1 means no match.
 * @param {MentionCandidate} c
 * @param {string} q
 * @returns {number}
 */
function rankCandidate(c, q) {
  const handle = c.handle.toLowerCase();
  const name = typeof c.name === "string" ? c.name.trim().toLowerCase() : "";
  const email = typeof c.email === "string" ? c.email.trim().toLowerCase() : "";
  const user = typeof c.user === "string" ? c.user.trim().toLowerCase() : "";
  const id = typeof c.id === "string" ? c.id.trim().toLowerCase() : "";

  if (!q) return 0;
  if (handle === q) return 0;
  if (handle.startsWith(q)) return 1;
  if (name && name.startsWith(q)) return 2;
  if (name) {
    const words = name.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      if (words[i].startsWith(q)) return 3;
    }
  }
  if (email && email.startsWith(q)) return 4;
  if ((user && user.startsWith(q)) || (id && id.startsWith(q))) return 5;
  return -1;
}

/**
 * Filter & rank participants who can see the board by prefix on handle, name, or email.
 * @param {string} query
 * @param {Participant[]} participants
 * @param {{ limit?: number }} [opts]
 * @returns {MentionCandidate[]}
 */
export function matchMentionCandidates(query, participants, opts = {}) {
  if (!Array.isArray(participants) || participants.length === 0) return [];
  const limit = typeof opts.limit === "number" && opts.limit >= 0 ? Math.floor(opts.limit) : DEFAULT_CANDIDATE_LIMIT;
  if (limit === 0) return [];

  const q = typeof query === "string" ? query.trim().replace(/^@+/, "").toLowerCase() : "";
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {{ candidate: MentionCandidate, rank: number, handleLower: string, nameLower: string }[]} */
  const scored = [];

  for (const p of participants) {
    if (!canSeeBoard(p)) continue;
    const handle = resolveHandle(p);
    if (!handle) continue;
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    /** @type {MentionCandidate} */
    const candidate = { ...p, handle };
    const rank = rankCandidate(candidate, q);
    if (rank < 0) continue;
    scored.push({
      candidate,
      rank,
      handleLower: key,
      nameLower: typeof p.name === "string" ? p.name.trim().toLowerCase() : "",
    });
  }

  scored.sort((a, b) => (
    a.rank - b.rank ||
    (q ? a.handleLower.length - b.handleLower.length : 0) ||
    cmpStr(a.handleLower, b.handleLower) ||
    cmpStr(a.nameLower, b.nameLower)
  ));

  return scored.slice(0, limit).map(s => s.candidate);
}

/**
 * Detect an active `@...` mention query at `cursorPos` for live autocomplete.
 * @param {string} text
 * @param {number} cursorPos
 * @returns {MentionQuery | null}
 */
export function extractMentionQuery(text, cursorPos) {
  if (typeof text !== "string" || typeof cursorPos !== "number" || !Number.isFinite(cursorPos)) return null;
  const end = Math.max(0, Math.min(text.length, Math.floor(cursorPos)));
  const before = text.slice(0, end);

  // Scan backward from cursor over valid mention query characters (including internal '@' for @email).
  let i = end - 1;
  let atIndex = -1;
  while (i >= 0) {
    const ch = before[i];
    if (ch === "@") {
      // Check if the character before this '@' is a valid mention boundary.
      const prev = i > 0 ? before[i - 1] : "";
      if (!prev || !/[A-Za-z0-9._%+@-]/.test(prev)) {
        atIndex = i;
        break;
      }
      // Otherwise this '@' may be the domain '@' inside "@alice@example" — keep scanning left.
      i--;
      continue;
    }
    if (!/[A-Za-z0-9._%+-]/.test(ch)) break;
    i--;
  }

  if (atIndex < 0) return null;
  const query = before.slice(atIndex + 1, end);
  if (query.length > MAX_TOKEN_LEN) return null;
  return { query, start: atIndex, end };
}

/**
 * Replace the active `@query` at `cursorPos` with `@<handle> ` and return `{ text, cursor }`.
 * @param {string} text
 * @param {number} cursorPos
 * @param {string | Participant} candidate
 * @returns {{ text: string, cursor: number }}
 */
export function insertMention(text, cursorPos, candidate) {
  const src = typeof text === "string" ? text : "";
  const safeCursor = typeof cursorPos === "number" && Number.isFinite(cursorPos)
    ? Math.max(0, Math.min(src.length, Math.floor(cursorPos)))
    : src.length;

  const handle = typeof candidate === "string"
    ? candidate.trim().replace(/^@+/, "")
    : resolveHandle(candidate);
  if (!handle) return { text: src, cursor: safeCursor };

  const active = extractMentionQuery(src, safeCursor);
  if (!active) return { text: src, cursor: safeCursor };

  const before = src.slice(0, active.start);
  const after = src.slice(active.end);
  const mention = `@${handle}`;
  const needsSpace = !after.startsWith(" ");
  const inserted = needsSpace ? `${mention} ` : mention;
  const nextText = before + inserted + after;
  const nextCursor = active.start + mention.length + 1;
  return { text: nextText, cursor: nextCursor };
}

/**
 * Build the lowercase set of identifiers that match `me`.
 * @param {UserIdentity} me
 * @returns {Set<string>}
 */
function identitySet(me) {
  /** @type {Set<string>} */
  const ids = new Set();
  if (!me) return ids;
  if (typeof me === "string") {
    const s = me.trim().replace(/^@+/, "").toLowerCase();
    if (s) ids.add(s);
    if (s.includes("@")) ids.add(s.split("@")[0]);
    return ids;
  }
  if (typeof me === "object") {
    for (const field of [me.id, me.user, me.handle, me.email]) {
      if (typeof field === "string" && field.trim()) {
        const s = field.trim().replace(/^@+/, "").toLowerCase();
        ids.add(s);
        if (s.includes("@")) ids.add(s.split("@")[0]);
      }
    }
  }
  return ids;
}

/**
 * Look up the last-read timestamp for a thread id.
 * @param {ReadAtMap} readAtByThread
 * @param {string} threadId
 * @returns {number | null}
 */
function getReadAt(readAtByThread, threadId) {
  if (!readAtByThread || !threadId) return null;
  if (readAtByThread instanceof Map) {
    const v = readAtByThread.get(threadId);
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  const v = readAtByThread[threadId];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * @param {CommentItem} c
 * @returns {boolean}
 */
function isDeletedComment(c) {
  return !c || c.deleted === true || (typeof c.deleted === "number" && c.deleted > 0);
}

/**
 * @param {CommentItem} c
 * @returns {string}
 */
function commentAuthor(c) {
  const raw = c.by ?? c.author ?? c.user ?? "";
  return typeof raw === "string" ? raw.trim().replace(/^@+/, "").toLowerCase() : "";
}

/**
 * Whether `c` mentions any identifier in `meIds`.
 * @param {CommentItem} c
 * @param {Set<string>} meIds
 * @returns {boolean}
 */
function commentMentionsMe(c, meIds) {
  if (meIds.size === 0 || isDeletedComment(c)) return false;
  if (Array.isArray(c.mentions)) {
    for (const m of c.mentions) {
      if (typeof m === "string" && meIds.has(m.trim().replace(/^@+/, "").toLowerCase())) return true;
    }
  }
  const tokens = parseMentions(c.text ?? "");
  for (const t of tokens) {
    if (meIds.has(t)) return true;
  }
  return false;
}

/**
 * Whether `c` is unread for `meIds` given `readAt`.
 * @param {CommentItem} c
 * @param {Set<string>} meIds
 * @param {number | null} readAt
 * @returns {boolean}
 */
function isUnreadComment(c, meIds, readAt) {
  if (isDeletedComment(c)) return false;
  const author = commentAuthor(c);
  if (author && meIds.has(author)) return false;
  if (readAt === null) return true;
  const at = typeof c.at === "number" && Number.isFinite(c.at) ? c.at : 0;
  return at > readAt;
}

/**
 * Filter comment threads by `"all" | "mentions" | "unread" | "resolved"`.
 * @param {CommentThread[]} threads
 * @param {{ filter?: ThreadFilter, me?: UserIdentity, readAtByThread?: ReadAtMap }} [opts]
 * @returns {CommentThread[]}
 */
export function filterCommentThreads(threads, opts = {}) {
  if (!Array.isArray(threads) || threads.length === 0) return [];
  const filter = opts.filter ?? "all";
  if (filter === "all") return [...threads];
  if (filter === "resolved") return threads.filter(t => Boolean(t && t.resolved));

  const meIds = identitySet(opts.me);
  if (filter === "mentions") {
    if (meIds.size === 0) return [];
    return threads.filter(t => {
      if (!t || !Array.isArray(t.comments)) return false;
      return t.comments.some(c => commentMentionsMe(c, meIds));
    });
  }

  if (filter === "unread") {
    return threads.filter(t => {
      if (!t || !Array.isArray(t.comments)) return false;
      const readAt = getReadAt(opts.readAtByThread, t.id);
      return t.comments.some(c => isUnreadComment(c, meIds, readAt));
    });
  }

  return [...threads];
}

/**
 * Compute badge counts for each thread filter pill (`all`, `mentions`, `unread`, `resolved`).
 * @param {CommentThread[]} threads
 * @param {{ me?: UserIdentity, readAtByThread?: ReadAtMap }} [opts]
 * @returns {{ all: number, mentions: number, unread: number, resolved: number }}
 */
export function countThreadFilters(threads, opts = {}) {
  const list = Array.isArray(threads) ? threads : [];
  return {
    all: list.length,
    mentions: filterCommentThreads(list, { ...opts, filter: "mentions" }).length,
    unread: filterCommentThreads(list, { ...opts, filter: "unread" }).length,
    resolved: filterCommentThreads(list, { ...opts, filter: "resolved" }).length,
  };
}

/**
 * Build unread mention and reply notifications for `me`, sorted newest-first.
 * @param {CommentThread[]} threads
 * @param {{ me?: UserIdentity, readAtByThread?: ReadAtMap, limit?: number }} [opts]
 * @returns {{ items: NotificationItem[], unreadCount: number }}
 */
export function buildNotifications(threads, opts = {}) {
  if (!Array.isArray(threads) || threads.length === 0) return { items: [], unreadCount: 0 };
  const meIds = identitySet(opts.me);
  if (meIds.size === 0) return { items: [], unreadCount: 0 };

  const limit = typeof opts.limit === "number" && opts.limit >= 0
    ? Math.floor(opts.limit)
    : DEFAULT_NOTIFICATION_LIMIT;

  /** @type {NotificationItem[]} */
  const allItems = [];

  for (const t of threads) {
    if (!t || !t.id || !Array.isArray(t.comments) || t.comments.length === 0) continue;
    const readAt = getReadAt(opts.readAtByThread, t.id);
    const threadAuthor = typeof t.by === "string" ? t.by.trim().replace(/^@+/, "").toLowerCase() : "";
    let meParticipated = Boolean(threadAuthor && meIds.has(threadAuthor));

    for (let i = 0; i < t.comments.length; i++) {
      const c = t.comments[i];
      if (isDeletedComment(c)) continue;
      const author = commentAuthor(c);
      const isMine = Boolean(author && meIds.has(author));
      if (isMine) {
        meParticipated = true;
        continue;
      }

      const mentioned = commentMentionsMe(c, meIds);
      const unread = isUnreadComment(c, meIds, readAt);

      if (unread && (mentioned || meParticipated)) {
        const commentId = typeof c.id === "string" && c.id ? c.id : String(i);
        allItems.push({
          id: `${t.id}:${commentId}`,
          threadId: t.id,
          commentId,
          kind: mentioned ? "mention" : "reply",
          by: c.by ?? c.author ?? c.user ?? "",
          authorName: c.name ?? c.by ?? c.author ?? c.user ?? "Someone",
          text: typeof c.text === "string" ? c.text : "",
          at: typeof c.at === "number" && Number.isFinite(c.at) ? c.at : 0,
          unread: true,
          resolved: Boolean(t.resolved),
        });
      }

      if (mentioned) meParticipated = true;
    }
  }

  allItems.sort((a, b) => (
    b.at - a.at ||
    (a.kind === b.kind ? 0 : a.kind === "mention" ? -1 : 1) ||
    cmpStr(a.id, b.id)
  ));

  return {
    items: limit > 0 ? allItems.slice(0, limit) : [],
    unreadCount: allItems.length,
  };
}

/**
 * Pure helper to return a new `readAtByThread` map with `threadId` marked read at `at`.
 * @param {Record<string, number> | null | undefined} readAtByThread
 * @param {string} threadId
 * @param {number} at
 * @returns {Record<string, number>}
 */
export function markThreadRead(readAtByThread, threadId, at) {
  const prev = readAtByThread && typeof readAtByThread === "object" ? readAtByThread : {};
  if (!threadId || typeof at !== "number" || !Number.isFinite(at)) return { ...prev };
  const current = typeof prev[threadId] === "number" ? prev[threadId] : -Infinity;
  return { ...prev, [threadId]: Math.max(current, at) };
}

/**
 * Pure helper to return a new `readAtByThread` map with all threads marked read at `at`.
 * @param {Record<string, number> | null | undefined} readAtByThread
 * @param {CommentThread[]} threads
 * @param {number} at
 * @returns {Record<string, number>}
 */
export function markAllThreadsRead(readAtByThread, threads, at) {
  const next = { ...(readAtByThread && typeof readAtByThread === "object" ? readAtByThread : {}) };
  if (!Array.isArray(threads) || typeof at !== "number" || !Number.isFinite(at)) return next;
  for (const t of threads) {
    if (!t || !t.id) continue;
    let latest = at;
    for (const c of t.comments ?? []) {
      if (c && typeof c.at === "number" && Number.isFinite(c.at) && c.at > latest) latest = c.at;
    }
    const current = typeof next[t.id] === "number" ? next[t.id] : -Infinity;
    next[t.id] = Math.max(current, latest);
  }
  return next;
}
