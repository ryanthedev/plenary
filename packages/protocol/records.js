// @ts-check
// Comment threads and reactions (PROTOCOL.md § Records): the state behind the `records` stream.
// Records don't merge by version: every copy applies the same actions in seq order. The room checks an
// action before logging it (`check`), so `apply` never meets a forbidden one; an action on a deleted
// comment or a hidden thread is accepted and changes nothing (a no-op, the same on every copy).
// Pure: a room and a replica both use it.

import { CAPS, canModerate } from "./envelope.js";
import { isAllHandsAction, allhandsProblem, MAX_POLLS, MAX_QUESTIONS } from "./allhands.js";

const bad = message => ({ code: "bad-op", message });
const limit = message => ({ code: "limit", message });
const forbidden = message => ({ code: "forbidden", message });
const copy = v => JSON.parse(JSON.stringify(v));

// Size is a function of the state alone (not of how it was reached), so a rebuilt room counts the same.
const THREAD_CHARS = 64, COMMENT_CHARS = 64, REACTION_CHARS = 8;
const POLL_CHARS = 64, VOTE_CHARS = 16, QUESTION_CHARS = 64, UPVOTE_CHARS = 8;
const threadChars = t => THREAD_CHARS + JSON.stringify(t.anchor).length;
const reactionChars = (emoji, user) => REACTION_CHARS + emoji.length + String(user).length;
const pollChars = p => POLL_CHARS + p.question.length + p.options.reduce((n, o) => n + o.length, 0);
const voteChars = user => VOTE_CHARS + String(user).length;
const questionChars = q => QUESTION_CHARS + q.text.length;
const upvoteChars = user => UPVOTE_CHARS + String(user).length;

function pollToJSON(p) {
  return {
    id: p.id, question: p.question, options: [...p.options],
    ...(p.anonymous ? { anonymous: true } : {}),
    by: p.by, name: p.name, at: p.at,
    closed: p.closed,
    ...(p.closed ? { closedBy: p.closedBy, closedAt: p.closedAt } : {}),
    votes: Object.fromEntries(p.votes),
  };
}

function questionToJSON(q) {
  return {
    id: q.id, text: q.text,
    ...(q.anonymous ? { anonymous: true } : {}),
    by: q.by, name: q.name, at: q.at, seq: q.seq,
    answered: q.answered,
    ...(q.answered ? { answeredBy: q.answeredBy, answeredAt: q.answeredAt } : {}),
    upvoters: [...q.upvoters],
  };
}

function threadToJSON(t) {
  return {
    id: t.id, anchor: copy(t.anchor), by: t.by, name: t.name, at: t.at, ...(t.resolved ? { resolved: { ...t.resolved } } : {}),
    // fromEntries defines own keys, so an emoji named like a prototype key stays plain data.
    comments: t.comments.map(c => ({ id: c.id, by: c.by, name: c.name, at: c.at, text: c.text, ...(c.edited !== undefined ? { edited: c.edited } : {}), ...(c.deleted !== undefined ? { deleted: c.deleted } : {}), reactions: Object.fromEntries([...c.reactions].map(([e, us]) => [e, [...us]])) })),
  };
}

export class Records {
  /** @param {{ threads?: object[], polls?: object[], questions?: object[] }} [data] the snapshot shape (§ Records, "Shape in snapshots") */
  constructor(data) { this.load(data); }

  load(data) {
    this.threads = new Map();    // thread id → { id, anchor, by, at, resolved?, comments: [], _json }, in creation order
    this.comments = new Map();   // comment id → { thread, comment }; a thread's first comment has the thread's id
    this.polls = new Map();      // poll id → { id, question, options, anonymous, by, name, at, closed, closedBy, closedAt, votes: Map, _json }
    this.questions = new Map();  // question id → { id, text, anonymous, by, name, at, seq, answered, answeredBy, answeredAt, upvoters: Set, _json }
    this.questionSeq = 0;
    this.chars = 0;
    this.rev = (this.rev ?? 0) + 1;
    for (const raw of data?.threads ?? []) this.addRaw(raw);
    for (const raw of data?.polls ?? []) this.addRawPoll(raw);
    for (const raw of data?.questions ?? []) this.addRawQuestion(raw);
  }

  /** Load one thread in the snapshot shape (`load` is this per thread; the incremental fold calls it a slice at a time). */
  addRaw(raw) {
    const t = { id: raw.id, anchor: copy(raw.anchor), by: raw.by, name: raw.name ?? null, at: raw.at, ...(raw.resolved ? { resolved: copy(raw.resolved) } : {}), comments: [], _json: null };
    this.threads.set(t.id, t); this.chars += threadChars(t);
    for (const rc of raw.comments ?? []) {
      const c = { id: rc.id, by: rc.by, name: rc.name ?? null, at: rc.at, text: rc.text, ...(rc.edited !== undefined ? { edited: rc.edited } : {}), ...(rc.deleted !== undefined ? { deleted: rc.deleted } : {}), reactions: new Map() };
      for (const [emoji, users] of Object.entries(rc.reactions ?? {})) { c.reactions.set(emoji, [...users]); for (const u of users) this.chars += reactionChars(emoji, u); }
      t.comments.push(c); this.comments.set(c.id, { thread: t, comment: c }); this.chars += COMMENT_CHARS + c.text.length;
    }
  }

  addRawPoll(raw) {
    const votes = new Map();
    for (const [user, idx] of Object.entries(raw.votes ?? {})) {
      votes.set(user, idx);
      this.chars += voteChars(user);
    }
    const p = {
      id: raw.id, question: raw.question, options: [...(raw.options ?? [])],
      anonymous: raw.anonymous === true, by: raw.by, name: raw.name ?? null, at: raw.at,
      closed: raw.closed === true, closedBy: raw.closedBy ?? null, closedAt: raw.closedAt ?? null,
      votes, _json: null,
    };
    this.polls.set(p.id, p);
    this.chars += pollChars(p);
  }

  addRawQuestion(raw) {
    const seq = Number.isSafeInteger(raw.seq) ? raw.seq : ++this.questionSeq;
    if (seq > this.questionSeq) this.questionSeq = seq;
    const upvoters = new Set();
    for (const user of raw.upvoters ?? []) {
      if (!upvoters.has(user)) { upvoters.add(user); this.chars += upvoteChars(user); }
    }
    const q = {
      id: raw.id, text: raw.text, anonymous: raw.anonymous === true,
      by: raw.by, name: raw.name ?? null, at: raw.at, seq,
      answered: raw.answered === true, answeredBy: raw.answeredBy ?? null, answeredAt: raw.answeredAt ?? null,
      upvoters, _json: null,
    };
    this.questions.set(q.id, q);
    this.chars += questionChars(q);
  }

  /** Plain snapshot JSON for one thread, cached per thread until that thread mutates (E-3). */
  threadJSON(id) {
    const t = this.threads.get(id);
    if (!t) return null;
    return t._json ?? (t._json = threadToJSON(t));
  }

  /** The snapshot shape: plain data, tombstones included. Reuses cached per-thread JSON for untouched threads. */
  toJSON() {
    const threads = [];
    for (const t of this.threads.values()) threads.push(t._json ?? (t._json = threadToJSON(t)));
    if (!this.polls.size && !this.questions.size) return { threads };
    /** @type {{ threads: object[], polls?: object[], questions?: object[] }} */
    const out = { threads };
    if (this.polls.size) {
      const polls = [];
      for (const p of this.polls.values()) polls.push(p._json ?? (p._json = pollToJSON(p)));
      out.polls = polls;
    }
    if (this.questions.size) {
      const questions = [];
      for (const q of this.questions.values()) questions.push(q._json ?? (q._json = questionToJSON(q)));
      out.questions = questions;
    }
    return out;
  }

  /** One thread in the snapshot shape (a copy; the incremental fold calls it a slice of threads at a time). */
  static threadJSON(t) {
    return threadToJSON(t);
  }

  static hidden(t) { return t.comments[0].deleted !== undefined; }
  dead(found) { return !found || found.comment.deleted !== undefined || Records.hidden(found.thread); }
  hasId(id) { return this.comments.has(id) || this.threads.has(id) || this.polls.has(id) || this.questions.has(id); }

  /**
   * May `by` (with `role`) do this action now? null = yes (also for a no-op on a dead target).
   * The room calls this before logging; replay never does (a logged action was already accepted).
   * @returns {null | { code: string, message: string }}
   */
  check(op, by, role) {
    if (isAllHandsAction(op?.do)) return this.checkAllHands(op, by, role);
    const t = this.threads.get(op.do === "reply" ? op.thread : op.id), found = this.comments.get(op.id);
    let grows = false;
    if (op.do === "thread") {
      if (this.hasId(op.id)) return bad("that record id is in use");
      if (this.threads.size >= CAPS.records.threads) return limit(`a board holds at most ${CAPS.records.threads} threads`);
      grows = true;
    } else if (op.do === "reply") {
      if (this.hasId(op.id)) return bad("that record id is in use");
      if (!t) return bad("no such thread");
      if (Records.hidden(t)) return null;
      if (t.comments.length >= CAPS.records.comments) return limit(`a thread holds at most ${CAPS.records.comments} comments`);
      grows = true;
    } else if (op.do === "edit") {
      if (!found) return bad("no such comment");
      if (found.comment.by !== by) return forbidden("only its author edits a comment");
      if (this.dead(found)) return null;
      grows = op.text.length > found.comment.text.length;
    } else if (op.do === "delete") {
      if (!found) return bad("no such comment");
      if (found.comment.by !== by && !canModerate(role)) return forbidden("that comment is someone else's");
    } else if (op.do === "resolve" || op.do === "reopen") {
      if (!t) return bad("no such thread");
    } else if (op.do === "move") {
      if (!t) return bad("no such thread");
      if (t.by !== by && !canModerate(role)) return forbidden("that thread is someone else's");
      grows = !Records.hidden(t);
    } else if (op.do === "react") {
      if (!found) return bad("no such comment");
      if (this.dead(found)) return null;
      const r = found.comment.reactions;
      if (op.on && !r.has(op.emoji) && r.size >= CAPS.records.emoji) return limit(`a comment holds at most ${CAPS.records.emoji} different emoji`);
      grows = op.on;
    } else return bad("unknown record action");
    if (grows && this.chars + JSON.stringify(op).length > CAPS.records.chars) return limit("the board's comments are full");
    return null;
  }

  /**
   * Bounded validation and authorization for live poll and audience Q&A actions (#16).
   * @returns {null | { code: string, message: string }}
   */
  checkAllHands(op, by, role) {
    const why = allhandsProblem(op);
    if (why) return why;
    let grows = false;
    if (op.do === "poll.create") {
      if (!canModerate(role)) return forbidden("only moderators can create polls");
      if (this.hasId(op.id)) return bad("that record id is in use");
      if (this.polls.size >= MAX_POLLS) return limit(`a board holds at most ${MAX_POLLS} polls`);
      grows = true;
    } else if (op.do === "poll.vote") {
      const p = this.polls.get(op.pollId ?? op.id);
      if (!p) return bad("no such poll");
      if (op.optionIndex >= p.options.length) return bad("optionIndex out of range for this poll");
      if (p.closed) return null;   // votes after close are accepted no-ops
      grows = !p.votes.has(by);
    } else if (op.do === "poll.close") {
      const p = this.polls.get(op.pollId ?? op.id);
      if (!p) return bad("no such poll");
      if (p.by !== by && !canModerate(role)) return forbidden("only the poll creator or a moderator can close a poll");
    } else if (op.do === "qa.ask") {
      if (this.hasId(op.id)) return bad("that record id is in use");
      if (this.questions.size >= MAX_QUESTIONS) return limit(`a board holds at most ${MAX_QUESTIONS} questions`);
      grows = true;
    } else if (op.do === "qa.upvote") {
      const q = this.questions.get(op.questionId ?? op.id);
      if (!q) return bad("no such question");
      const want = typeof op.on === "boolean" ? op.on : !q.upvoters.has(by);
      grows = want && !q.upvoters.has(by);
    } else if (op.do === "qa.answer") {
      const q = this.questions.get(op.questionId ?? op.id);
      if (!q) return bad("no such question");
      if (!canModerate(role)) return forbidden("only moderators can mark questions answered");
    }
    if (grows && this.chars + JSON.stringify(op).length > CAPS.records.chars) return limit("the board's records are full");
    return null;
  }

  /**
   * Apply one accepted action. `by`, `at` and `name` (the author's display name when it was written) come
   * from the log entry, never the payload. True if anything changed; a no-op is decided from the state
   * alone, so replay agrees.
   */
  apply(op, by, at, name = null) {
    const changed = this.act(op, by, at, name);
    if (changed) this.rev++;
    return changed;
  }

  act(op, by, at, name) {
    if (!op || typeof op !== "object") return false;
    if (isAllHandsAction(op.do)) return this.actAllHands(op, by, at, name);
    if (op.do === "thread") {
      if (this.hasId(op.id)) return false;
      const t = { id: op.id, anchor: copy(op.anchor), by, name, at, comments: [], _json: null };
      this.threads.set(t.id, t); this.chars += threadChars(t);
      return this.add(t, op, by, at, name);
    }
    if (op.do === "reply") {
      const t = this.threads.get(op.thread);
      if (!t || Records.hidden(t) || this.hasId(op.id)) return false;
      return this.add(t, op, by, at, name);
    }
    if (op.do === "resolve" || op.do === "reopen" || op.do === "move") {
      const t = this.threads.get(op.id);
      if (!t || Records.hidden(t)) return false;
      if (op.do === "move") { this.chars -= threadChars(t); t.anchor = copy(op.anchor); this.chars += threadChars(t); t._json = null; return true; }
      if ((op.do === "resolve") === !!t.resolved) return false;   // repeating is a no-op
      if (op.do === "resolve") t.resolved = { by, name, at }; else delete t.resolved;
      t._json = null;
      return true;
    }
    const found = this.comments.get(op.id);
    if (!found) return false;
    const c = found.comment;
    if (op.do === "delete") {
      if (c.deleted !== undefined) return false;
      this.chars -= c.text.length;
      for (const [emoji, users] of c.reactions) for (const u of users) this.chars -= reactionChars(emoji, u);
      c.text = ""; c.reactions = new Map(); c.deleted = at; found.thread._json = null;
      return true;
    }
    if (this.dead(found)) return false;
    if (op.do === "edit") { this.chars += op.text.length - c.text.length; c.text = op.text; c.edited = at; found.thread._json = null; return true; }
    if (op.do === "react") {
      // Set, never flip: keyed by (comment, user, emoji), so a resend or a replay lands the same.
      const users = c.reactions.get(op.emoji) ?? [], has = users.includes(by);
      if (op.on === has) return false;
      if (op.on) { users.push(by); c.reactions.set(op.emoji, users); this.chars += reactionChars(op.emoji, by); }
      else { users.splice(users.indexOf(by), 1); if (!users.length) c.reactions.delete(op.emoji); this.chars -= reactionChars(op.emoji, by); }
      found.thread._json = null;
      return true;
    }
    return false;
  }

  actAllHands(op, by, at, name) {
    if (allhandsProblem(op)) return false;
    if (op.do === "poll.create") {
      if (this.hasId(op.id)) return false;
      const p = {
        id: op.id, question: op.question, options: [...op.options],
        anonymous: op.anonymous === true, by, name, at,
        closed: false, closedBy: null, closedAt: null,
        votes: new Map(), _json: null,
      };
      this.polls.set(p.id, p);
      this.chars += pollChars(p);
      return true;
    }
    if (op.do === "poll.vote") {
      const p = this.polls.get(op.pollId ?? op.id);
      if (!p || p.closed || typeof by !== "string" || !by.length) return false;
      if (op.optionIndex < 0 || op.optionIndex >= p.options.length) return false;
      if (p.votes.get(by) === op.optionIndex) return false;
      if (!p.votes.has(by)) this.chars += voteChars(by);
      p.votes.set(by, op.optionIndex);
      p._json = null;
      return true;
    }
    if (op.do === "poll.close") {
      const p = this.polls.get(op.pollId ?? op.id);
      if (!p || p.closed) return false;
      p.closed = true;
      p.closedBy = by;
      p.closedAt = at;
      p._json = null;
      return true;
    }
    if (op.do === "qa.ask") {
      if (this.hasId(op.id)) return false;
      const q = {
        id: op.id, text: op.text, anonymous: op.anonymous === true,
        by, name, at, seq: ++this.questionSeq,
        answered: false, answeredBy: null, answeredAt: null,
        upvoters: new Set(), _json: null,
      };
      this.questions.set(q.id, q);
      this.chars += questionChars(q);
      return true;
    }
    if (op.do === "qa.upvote") {
      const q = this.questions.get(op.questionId ?? op.id);
      if (!q || typeof by !== "string" || !by.length) return false;
      const has = q.upvoters.has(by);
      const want = typeof op.on === "boolean" ? op.on : !has;
      if (want === has) return false;
      if (want) { q.upvoters.add(by); this.chars += upvoteChars(by); }
      else { q.upvoters.delete(by); this.chars -= upvoteChars(by); }
      q._json = null;
      return true;
    }
    if (op.do === "qa.answer") {
      const q = this.questions.get(op.questionId ?? op.id);
      if (!q) return false;
      const want = op.answered !== false;
      if (q.answered === want) return false;
      q.answered = want;
      q.answeredBy = want ? by : null;
      q.answeredAt = want ? at : null;
      q._json = null;
      return true;
    }
    return false;
  }

  add(t, op, by, at, name) {
    const c = { id: op.id, by, name, at, text: op.text, reactions: new Map() };
    t.comments.push(c); this.comments.set(c.id, { thread: t, comment: c }); this.chars += COMMENT_CHARS + c.text.length;
    t._json = null;
    return true;
  }
}
