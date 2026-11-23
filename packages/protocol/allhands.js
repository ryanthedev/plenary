// @ts-check
// All-hands live polls, audience Q&A, and anonymous mode (PROTOCOL.md § Records, #15, #16).
// Pure leaf module: imports nothing and uses no host globals, so rooms, browsers, phones and Herdr panes agree.

export const MAX_ID_CHARS = 64;
export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTIONS = 10;
export const MAX_POLL_OPTION_CHARS = 120;
export const MAX_POLL_QUESTION_CHARS = 240;
export const MAX_QA_QUESTION_CHARS = 500;
export const MAX_POLLS = 500;
export const MAX_QUESTIONS = 2_000;
export const ANONYMOUS_LABEL = "Anonymous";

export const ALLHANDS_ACTIONS = Object.freeze([
  "poll.create",
  "poll.vote",
  "poll.close",
  "qa.ask",
  "qa.upvote",
  "qa.answer",
]);

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
const isId = v => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_CHARS;
const bad = message => ({ code: "bad-op", message });
const limit = message => ({ code: "limit", message });

/**
 * @param {string} action
 * @returns {boolean}
 */
export function isAllHandsAction(action) {
  return typeof action === "string" && ALLHANDS_ACTIONS.includes(action);
}

/**
 * Copy optional caller-provided record metadata (`by`, `author`, `authorName`, `name`, `at`, `seq`)
 * when building standalone event-log records. Wire ops omit these (the room stamps `by`, `name`, `at`, `seq`).
 * @param {Record<string, any>} src
 * @returns {Record<string, any>}
 */
function pickMeta(src) {
  /** @type {Record<string, any>} */
  const out = {};
  if (src.by !== undefined) out.by = src.by;
  if (src.author !== undefined) out.author = src.author;
  if (src.authorName !== undefined) out.authorName = src.authorName;
  if (src.name !== undefined) out.name = src.name;
  if (src.at !== undefined) out.at = src.at;
  if (src.seq !== undefined) out.seq = src.seq;
  return out;
}

/**
 * @param {Record<string, any>} op
 * @param {readonly string[]} allowed
 * @returns {string | null}
 */
function unknownKey(op, allowed) {
  for (const k of Object.keys(op)) {
    if (!allowed.includes(k)) return k;
  }
  return null;
}

/**
 * Resolve a target id from either `op[primary]` or `op.id`, ensuring they match if both are supplied.
 * @param {Record<string, any>} op
 * @param {string} primary
 * @returns {{ id: string | null, mismatch: boolean }}
 */
function targetId(op, primary) {
  const hasPrimary = hasOwn(op, primary) && op[primary] !== undefined;
  const hasId = hasOwn(op, "id") && op.id !== undefined;
  if (hasPrimary && hasId && op[primary] !== op.id) return { id: null, mismatch: true };
  const raw = hasPrimary ? op[primary] : op.id;
  return { id: isId(raw) ? raw : null, mismatch: false };
}

/**
 * Strict bounded validator for poll & Q&A record actions.
 * Returns `{ code: "bad-op" | "limit", message }` or `null` when valid.
 * @param {any} op
 * @returns {null | { code: string, message: string }}
 */
export function allhandsProblem(op) {
  if (!isObj(op) || !isAllHandsAction(op.do)) return bad(`unknown all-hands record action ${JSON.stringify(op?.do)}`);

  if (op.do === "poll.create") {
    const extra = unknownKey(op, ["do", "id", "question", "options", "anonymous"]);
    if (extra) return bad(`unknown poll.create field ${JSON.stringify(extra)}`);
    if (!isId(op.id)) return bad(`poll id must be a string of 1..${MAX_ID_CHARS} characters`);
    if (typeof op.question !== "string" || op.question.trim().length === 0) return bad("poll question must be a non-empty string");
    if (op.question.length > MAX_POLL_QUESTION_CHARS) return limit(`poll question is limited to ${MAX_POLL_QUESTION_CHARS} characters`);
    if (!Array.isArray(op.options)) return bad("poll options must be an array");
    if (op.options.length < MIN_POLL_OPTIONS) return bad(`a poll needs at least ${MIN_POLL_OPTIONS} options`);
    if (op.options.length > MAX_POLL_OPTIONS) return limit(`a poll is limited to ${MAX_POLL_OPTIONS} options`);
    for (const opt of op.options) {
      if (typeof opt !== "string" || opt.trim().length === 0) return bad("each poll option must be a non-empty string");
      if (opt.length > MAX_POLL_OPTION_CHARS) return limit(`each poll option is limited to ${MAX_POLL_OPTION_CHARS} characters`);
    }
    if (op.anonymous !== undefined && typeof op.anonymous !== "boolean") return bad("poll anonymous flag must be a boolean");
    return null;
  }

  if (op.do === "poll.vote") {
    const extra = unknownKey(op, ["do", "id", "pollId", "optionIndex"]);
    if (extra) return bad(`unknown poll.vote field ${JSON.stringify(extra)}`);
    const { id, mismatch } = targetId(op, "pollId");
    if (mismatch) return bad("poll.vote id and pollId must match");
    if (!id) return bad(`pollId must be a string of 1..${MAX_ID_CHARS} characters`);
    if (!Number.isSafeInteger(op.optionIndex) || op.optionIndex < 0 || op.optionIndex >= MAX_POLL_OPTIONS) {
      return bad(`optionIndex must be an integer between 0 and ${MAX_POLL_OPTIONS - 1}`);
    }
    return null;
  }

  if (op.do === "poll.close") {
    const extra = unknownKey(op, ["do", "id", "pollId"]);
    if (extra) return bad(`unknown poll.close field ${JSON.stringify(extra)}`);
    const { id, mismatch } = targetId(op, "pollId");
    if (mismatch) return bad("poll.close id and pollId must match");
    if (!id) return bad(`pollId must be a string of 1..${MAX_ID_CHARS} characters`);
    return null;
  }

  if (op.do === "qa.ask") {
    const extra = unknownKey(op, ["do", "id", "text", "anonymous"]);
    if (extra) return bad(`unknown qa.ask field ${JSON.stringify(extra)}`);
    if (!isId(op.id)) return bad(`question id must be a string of 1..${MAX_ID_CHARS} characters`);
    if (typeof op.text !== "string" || op.text.trim().length === 0) return bad("question text must be a non-empty string");
    if (op.text.length > MAX_QA_QUESTION_CHARS) return limit(`question text is limited to ${MAX_QA_QUESTION_CHARS} characters`);
    if (op.anonymous !== undefined && typeof op.anonymous !== "boolean") return bad("question anonymous flag must be a boolean");
    return null;
  }

  if (op.do === "qa.upvote") {
    const extra = unknownKey(op, ["do", "id", "questionId", "on"]);
    if (extra) return bad(`unknown qa.upvote field ${JSON.stringify(extra)}`);
    const { id, mismatch } = targetId(op, "questionId");
    if (mismatch) return bad("qa.upvote id and questionId must match");
    if (!id) return bad(`questionId must be a string of 1..${MAX_ID_CHARS} characters`);
    if (op.on !== undefined && typeof op.on !== "boolean") return bad("qa.upvote on must be a boolean");
    return null;
  }

  if (op.do === "qa.answer") {
    const extra = unknownKey(op, ["do", "id", "questionId", "answered"]);
    if (extra) return bad(`unknown qa.answer field ${JSON.stringify(extra)}`);
    const { id, mismatch } = targetId(op, "questionId");
    if (mismatch) return bad("qa.answer id and questionId must match");
    if (!id) return bad(`questionId must be a string of 1..${MAX_ID_CHARS} characters`);
    if (op.answered !== undefined && typeof op.answered !== "boolean") return bad("qa.answer answered must be a boolean");
    return null;
  }

  return bad("unknown all-hands record action");
}

// ---- Live Polls ----

/**
 * Create a validated `poll.create` record (2..10 options <= 120 chars each, question <= 240 chars).
 * @param {{ id: string, question: string, options: string[], anonymous?: boolean, by?: string, author?: string, authorName?: string | null, name?: string | null, at?: number, seq?: number }} input
 */
export function createPollRecord(input) {
  if (!isObj(input)) throw new Error("poll input must be an object");
  /** @type {Record<string, any>} */
  const core = {
    do: "poll.create",
    id: input.id,
    question: input.question,
    options: Array.isArray(input.options) ? [...input.options] : input.options,
    ...(input.anonymous !== undefined ? { anonymous: input.anonymous } : {}),
  };
  const why = allhandsProblem(core);
  if (why) throw new Error(why.message);
  return { ...core, ...pickMeta(input) };
}

/**
 * Create a validated `poll.vote` record.
 * @param {{ pollId?: string, id?: string, optionIndex: number, by?: string, author?: string, authorName?: string | null, name?: string | null, at?: number, seq?: number }} input
 */
export function votePollRecord(input) {
  if (!isObj(input)) throw new Error("vote input must be an object");
  const pollId = input.pollId ?? input.id;
  const core = { do: "poll.vote", id: pollId, pollId, optionIndex: input.optionIndex };
  const why = allhandsProblem(core);
  if (why) throw new Error(why.message);
  return { ...core, ...pickMeta(input) };
}

/**
 * Create a validated `poll.close` record.
 * @param {{ pollId?: string, id?: string, by?: string, author?: string, authorName?: string | null, name?: string | null, at?: number, seq?: number }} input
 */
export function closePollRecord(input) {
  if (!isObj(input)) throw new Error("close poll input must be an object");
  const pollId = input.pollId ?? input.id;
  const core = { do: "poll.close", id: pollId, pollId };
  const why = allhandsProblem(core);
  if (why) throw new Error(why.message);
  return { ...core, ...pickMeta(input) };
}

/**
 * Normalize an iterable of flat records or room log entries `{ seq, by, name, at, op }`
 * into a deterministic sequence-ordered list.
 * @param {Iterable<any> | null | undefined} records
 * @returns {Array<{ op: Record<string, any>, by: string | null, authorName: string | null, at: number | null, seq: number, order: number }>}
 */
function normalizeRecords(records) {
  if (!records) return [];
  const list = [];
  let index = 0;
  let allHaveSeq = true;
  for (const raw of records) {
    if (!isObj(raw)) continue;
    const op = isObj(raw.op) ? raw.op : raw;
    const rawSeq = raw.seq !== undefined ? raw.seq : op.seq;
    const hasSeq = Number.isSafeInteger(rawSeq);
    if (!hasSeq) allHaveSeq = false;
    const byRaw = raw.by ?? raw.author ?? op.by ?? op.author ?? null;
    const by = typeof byRaw === "string" && byRaw.length > 0 ? byRaw : null;
    const nameRaw = raw.authorName ?? raw.name ?? op.authorName ?? op.name ?? null;
    const authorName = typeof nameRaw === "string" ? nameRaw : null;
    const atRaw = raw.at !== undefined ? raw.at : op.at;
    const at = typeof atRaw === "number" && Number.isFinite(atRaw) ? atRaw : null;
    list.push({ op, by, authorName, at, seq: hasSeq ? rawSeq : index, order: index });
    index++;
  }
  if (allHaveSeq && list.length > 1) {
    list.sort((a, b) => a.seq - b.seq || a.order - b.order);
  }
  return list;
}

/**
 * Tally a live poll from a sequence of records (or log entries).
 * - Strict 1-vote-per-user deduplication: latest vote wins, changing vote updates counts cleanly.
 * - Votes after `poll.close` (or before `poll.create`) are ignored.
 * - Returns `null` if `pollId` was never created.
 * @param {Iterable<any> | null | undefined} records
 * @param {string} pollId
 */
export function tallyPoll(records, pollId) {
  if (!isId(pollId)) return null;
  const items = normalizeRecords(records);

  /** @type {{ id: string, question: string, options: string[], anonymous: boolean, by: string | null, authorName: string | null, at: number | null, seq: number, closed: boolean, closedAt: number | null, closedBy: string | null } | null} */
  let poll = null;
  /** @type {Map<string, number>} */
  const votesByUser = new Map();

  for (const item of items) {
    const { op, by, authorName, at, seq } = item;
    if (op.do === "poll.create" && op.id === pollId) {
      if (poll) continue;
      if (allhandsProblem({ do: "poll.create", id: op.id, question: op.question, options: op.options, ...(op.anonymous !== undefined ? { anonymous: op.anonymous } : {}) })) continue;
      poll = {
        id: pollId,
        question: op.question,
        options: [...op.options],
        anonymous: op.anonymous === true,
        by,
        authorName,
        at,
        seq,
        closed: false,
        closedAt: null,
        closedBy: null,
      };
      continue;
    }
    if (!poll) continue;
    const tid = op.pollId ?? op.id;
    if (tid !== pollId) continue;

    if (op.do === "poll.close") {
      if (!poll.closed) {
        poll.closed = true;
        poll.closedAt = at;
        poll.closedBy = by;
      }
      continue;
    }

    if (op.do === "poll.vote") {
      if (poll.closed) continue;
      if (!by) continue;
      if (!Number.isSafeInteger(op.optionIndex) || op.optionIndex < 0 || op.optionIndex >= poll.options.length) continue;
      votesByUser.set(by, op.optionIndex);
    }
  }

  if (!poll) return null;

  const counts = new Array(poll.options.length).fill(0);
  for (const idx of votesByUser.values()) counts[idx]++;
  const totalVotes = votesByUser.size;
  const results = poll.options.map((label, index) => ({
    index,
    label,
    votes: counts[index],
    percent: totalVotes > 0 ? Math.round((counts[index] / totalVotes) * 1000) / 10 : 0,
  }));

  return {
    id: poll.id,
    question: poll.question,
    options: poll.options,
    anonymous: poll.anonymous,
    by: poll.by,
    author: poll.by,
    authorName: poll.authorName,
    at: poll.at,
    seq: poll.seq,
    closed: poll.closed,
    closedAt: poll.closedAt,
    closedBy: poll.closedBy,
    counts,
    totalVotes,
    results,
    voters: Object.fromEntries(votesByUser),
  };
}

// ---- Audience Q&A ----

/**
 * Create a validated `qa.ask` record (question text <= 500 chars).
 * @param {{ id: string, text?: string, question?: string, anonymous?: boolean, by?: string, author?: string, authorName?: string | null, name?: string | null, at?: number, seq?: number }} input
 */
export function createQuestionRecord(input) {
  if (!isObj(input)) throw new Error("question input must be an object");
  const text = input.text !== undefined ? input.text : input.question;
  /** @type {Record<string, any>} */
  const core = {
    do: "qa.ask",
    id: input.id,
    text,
    ...(input.anonymous !== undefined ? { anonymous: input.anonymous } : {}),
  };
  const why = allhandsProblem(core);
  if (why) throw new Error(why.message);
  return { ...core, ...pickMeta(input) };
}

/**
 * Create a validated `qa.upvote` record (1-upvote-per-user toggle dedup, or explicit `on` boolean).
 * @param {{ questionId?: string, id?: string, on?: boolean, by?: string, author?: string, authorName?: string | null, name?: string | null, at?: number, seq?: number }} input
 */
export function upvoteQuestionRecord(input) {
  if (!isObj(input)) throw new Error("upvote input must be an object");
  const questionId = input.questionId ?? input.id;
  /** @type {Record<string, any>} */
  const core = {
    do: "qa.upvote",
    id: questionId,
    questionId,
    ...(input.on !== undefined ? { on: input.on } : {}),
  };
  const why = allhandsProblem(core);
  if (why) throw new Error(why.message);
  return { ...core, ...pickMeta(input) };
}

/**
 * Create a validated `qa.answer` record.
 * @param {{ questionId?: string, id?: string, answered?: boolean, by?: string, author?: string, authorName?: string | null, name?: string | null, at?: number, seq?: number }} input
 */
export function answerQuestionRecord(input) {
  if (!isObj(input)) throw new Error("answer input must be an object");
  const questionId = input.questionId ?? input.id;
  const answered = input.answered !== undefined ? input.answered : true;
  const core = { do: "qa.answer", id: questionId, questionId, answered };
  const why = allhandsProblem(core);
  if (why) throw new Error(why.message);
  return { ...core, ...pickMeta(input) };
}

/**
 * Rank audience Q&A questions from a sequence of records (or log entries).
 * - 1-upvote-per-user toggle deduplication (or explicit `on: boolean`).
 * - Sorted strictly by `(answered asc, upvotes desc, seq asc)`.
 * @param {Iterable<any> | null | undefined} records
 */
export function rankQuestions(records) {
  const items = normalizeRecords(records);
  /** @type {Map<string, { id: string, text: string, anonymous: boolean, by: string | null, authorName: string | null, at: number | null, seq: number, order: number, answered: boolean, answeredAt: number | null, answeredBy: string | null, upvoters: Set<string> }>} */
  const questions = new Map();

  for (const item of items) {
    const { op, by, authorName, at, seq, order } = item;
    if (op.do === "qa.ask") {
      if (!isId(op.id) || questions.has(op.id)) continue;
      if (allhandsProblem({ do: "qa.ask", id: op.id, text: op.text, ...(op.anonymous !== undefined ? { anonymous: op.anonymous } : {}) })) continue;
      questions.set(op.id, {
        id: op.id,
        text: op.text,
        anonymous: op.anonymous === true,
        by,
        authorName,
        at,
        seq,
        order,
        answered: false,
        answeredAt: null,
        answeredBy: null,
        upvoters: new Set(),
      });
      continue;
    }

    const qid = op.questionId ?? op.id;
    if (!isId(qid)) continue;
    const q = questions.get(qid);
    if (!q) continue;

    if (op.do === "qa.upvote") {
      if (!by) continue;
      if (typeof op.on === "boolean") {
        if (op.on) q.upvoters.add(by);
        else q.upvoters.delete(by);
      } else if (q.upvoters.has(by)) {
        q.upvoters.delete(by);
      } else {
        q.upvoters.add(by);
      }
      continue;
    }

    if (op.do === "qa.answer") {
      const answered = op.answered !== false;
      if (q.answered === answered) continue;
      q.answered = answered;
      q.answeredAt = answered ? at : null;
      q.answeredBy = answered ? by : null;
    }
  }

  const ranked = [...questions.values()].map(q => ({
    id: q.id,
    text: q.text,
    anonymous: q.anonymous,
    by: q.by,
    author: q.by,
    authorName: q.authorName,
    at: q.at,
    seq: q.seq,
    answered: q.answered,
    answeredAt: q.answeredAt,
    answeredBy: q.answeredBy,
    upvotes: q.upvoters.size,
    upvoters: [...q.upvoters],
    _order: q.order,
  }));

  ranked.sort((a, b) =>
    (Number(a.answered) - Number(b.answered)) ||
    (b.upvotes - a.upvotes) ||
    (a.seq - b.seq) ||
    (a._order - b._order)
  );

  return ranked.map(({ _order, ...rest }) => rest);
}

// ---- Anonymous Mode (#15) ----

/**
 * Mask author identity for anonymous mode (#15).
 * When `anonymous && !revealed`:
 *   - `author` and `authorName` (plus `by` / `name` when present) become deterministic `"Anonymous"`.
 *   - `isMine` is `true` iff `viewerUserId` matches the item's real author, so authors still recognize their own items.
 * When `!anonymous || revealed`:
 *   - Real `author` / `authorName` are preserved cleanly and `isMine` is still computed.
 * Never mutates `item`.
 * @template {Record<string, any>} T
 * @param {T} item
 * @param {{ anonymous?: boolean, viewerUserId?: string | null, revealed?: boolean }} [options]
 * @returns {(T & { author: string | null, authorName: string | null, isMine: boolean }) | null}
 */
export function maskAuthor(item, options = {}) {
  if (!isObj(item)) return null;
  const { anonymous, viewerUserId = null, revealed = false } = isObj(options) ? options : {};
  const effectiveAnonymous = anonymous !== undefined ? Boolean(anonymous) : Boolean(item.anonymous);
  const realAuthorRaw = item.author !== undefined ? item.author : (item.by !== undefined ? item.by : null);
  const realAuthor = typeof realAuthorRaw === "string" && realAuthorRaw.length > 0 ? realAuthorRaw : null;
  const realNameRaw = item.authorName !== undefined ? item.authorName : (item.name !== undefined ? item.name : null);
  const realName = typeof realNameRaw === "string" ? realNameRaw : null;
  const isMine = typeof viewerUserId === "string" && viewerUserId.length > 0 && realAuthor !== null && realAuthor === viewerUserId;

  const isRevealed = revealed === true;
  if (effectiveAnonymous && !isRevealed) {
    /** @type {Record<string, any>} */
    const masked = {
      ...item,
      author: ANONYMOUS_LABEL,
      authorName: ANONYMOUS_LABEL,
      isMine,
    };
    if (hasOwn(item, "by")) masked.by = ANONYMOUS_LABEL;
    if (hasOwn(item, "name")) masked.name = ANONYMOUS_LABEL;
    return /** @type {any} */ (masked);
  }

  return /** @type {any} */ ({
    ...item,
    author: realAuthor,
    authorName: realName,
    isMine,
  });
}
