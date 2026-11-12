// Comment threads and reactions (PROTOCOL.md § Records): the state behind the `records` stream.
// Records don't merge by version: every copy applies the same actions in seq order. The room checks an
// action before logging it (`check`), so `apply` never meets a forbidden one; an action on a deleted
// comment or a hidden thread is accepted and changes nothing (a no-op, the same on every copy).
// Pure: a room and a replica both use it.

import { CAPS, canModerate } from "./envelope.js";

const bad = message => ({ code: "bad-op", message });
const limit = message => ({ code: "limit", message });
const forbidden = message => ({ code: "forbidden", message });
const copy = v => JSON.parse(JSON.stringify(v));

// Size is a function of the state alone (not of how it was reached), so a rebuilt room counts the same.
const THREAD_CHARS = 64, COMMENT_CHARS = 64, REACTION_CHARS = 8;
const threadChars = t => THREAD_CHARS + JSON.stringify(t.anchor).length;
const reactionChars = (emoji, user) => REACTION_CHARS + emoji.length + String(user).length;

export class Records {
  /** @param {{ threads: object[] }} [data] the snapshot shape (§ Records, "Shape in snapshots") */
  constructor(data) { this.load(data); }

  load(data) {
    this.threads = new Map();    // thread id → { id, anchor, by, at, resolved?, comments: [] }, in creation order
    this.comments = new Map();   // comment id → { thread, comment }; a thread's first comment has the thread's id
    this.chars = 0;
    this.rev = (this.rev ?? 0) + 1;
    for (const raw of data?.threads ?? []) {
      const t = { id: raw.id, anchor: copy(raw.anchor), by: raw.by, name: raw.name ?? null, at: raw.at, ...(raw.resolved ? { resolved: copy(raw.resolved) } : {}), comments: [] };
      this.threads.set(t.id, t); this.chars += threadChars(t);
      for (const rc of raw.comments ?? []) {
        const c = { id: rc.id, by: rc.by, name: rc.name ?? null, at: rc.at, text: rc.text, ...(rc.edited !== undefined ? { edited: rc.edited } : {}), ...(rc.deleted !== undefined ? { deleted: rc.deleted } : {}), reactions: new Map() };
        for (const [emoji, users] of Object.entries(rc.reactions ?? {})) { c.reactions.set(emoji, [...users]); for (const u of users) this.chars += reactionChars(emoji, u); }
        t.comments.push(c); this.comments.set(c.id, { thread: t, comment: c }); this.chars += COMMENT_CHARS + c.text.length;
      }
    }
  }

  /** The snapshot shape: plain data, tombstones included. */
  toJSON() {
    const threads = [];
    for (const t of this.threads.values()) threads.push({
      id: t.id, anchor: copy(t.anchor), by: t.by, name: t.name, at: t.at, ...(t.resolved ? { resolved: { ...t.resolved } } : {}),
      // fromEntries defines own keys, so an emoji named like a prototype key stays plain data.
      comments: t.comments.map(c => ({ id: c.id, by: c.by, name: c.name, at: c.at, text: c.text, ...(c.edited !== undefined ? { edited: c.edited } : {}), ...(c.deleted !== undefined ? { deleted: c.deleted } : {}), reactions: Object.fromEntries([...c.reactions].map(([e, us]) => [e, [...us]])) })),
    });
    return { threads };
  }

  static hidden(t) { return t.comments[0].deleted !== undefined; }
  dead(found) { return !found || found.comment.deleted !== undefined || Records.hidden(found.thread); }

  /**
   * May `by` (with `role`) do this action now? null = yes (also for a no-op on a dead target).
   * The room calls this before logging; replay never does (a logged action was already accepted).
   * @returns {null | { code: string, message: string }}
   */
  check(op, by, role) {
    const t = this.threads.get(op.do === "reply" ? op.thread : op.id), found = this.comments.get(op.id);
    let grows = false;
    if (op.do === "thread") {
      if (found) return bad("that record id is in use");
      if (this.threads.size >= CAPS.records.threads) return limit(`a board holds at most ${CAPS.records.threads} threads`);
      grows = true;
    } else if (op.do === "reply") {
      if (found) return bad("that record id is in use");
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
    if (op.do === "thread") {
      if (this.comments.has(op.id) || this.threads.has(op.id)) return false;
      const t = { id: op.id, anchor: copy(op.anchor), by, name, at, comments: [] };
      this.threads.set(t.id, t); this.chars += threadChars(t);
      return this.add(t, op, by, at, name);
    }
    if (op.do === "reply") {
      const t = this.threads.get(op.thread);
      if (!t || Records.hidden(t) || this.comments.has(op.id)) return false;
      return this.add(t, op, by, at, name);
    }
    if (op.do === "resolve" || op.do === "reopen" || op.do === "move") {
      const t = this.threads.get(op.id);
      if (!t || Records.hidden(t)) return false;
      if (op.do === "move") { this.chars -= threadChars(t); t.anchor = copy(op.anchor); this.chars += threadChars(t); return true; }
      if ((op.do === "resolve") === !!t.resolved) return false;   // repeating is a no-op
      if (op.do === "resolve") t.resolved = { by, name, at }; else delete t.resolved;
      return true;
    }
    const found = this.comments.get(op.id);
    if (!found) return false;
    const c = found.comment;
    if (op.do === "delete") {
      if (c.deleted !== undefined) return false;
      this.chars -= c.text.length;
      for (const [emoji, users] of c.reactions) for (const u of users) this.chars -= reactionChars(emoji, u);
      c.text = ""; c.reactions = new Map(); c.deleted = at;
      return true;
    }
    if (this.dead(found)) return false;
    if (op.do === "edit") { this.chars += op.text.length - c.text.length; c.text = op.text; c.edited = at; return true; }
    if (op.do === "react") {
      // Set, never flip: keyed by (comment, user, emoji), so a resend or a replay lands the same.
      const users = c.reactions.get(op.emoji) ?? [], has = users.includes(by);
      if (op.on === has) return false;
      if (op.on) { users.push(by); c.reactions.set(op.emoji, users); this.chars += reactionChars(op.emoji, by); }
      else { users.splice(users.indexOf(by), 1); if (!users.length) c.reactions.delete(op.emoji); this.chars -= reactionChars(op.emoji, by); }
      return true;
    }
    return false;
  }

  add(t, op, by, at, name) {
    const c = { id: op.id, by, name, at, text: op.text, reactions: new Map() };
    t.comments.push(c); this.comments.set(c.id, { thread: t, comment: c }); this.chars += COMMENT_CHARS + c.text.length;
    return true;
  }
}
