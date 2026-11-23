// All-hands live polls, audience Q&A, and anonymous mode (#15, #16).
import { test, expect } from "bun:test";
import {
  MAX_ID_CHARS,
  MIN_POLL_OPTIONS,
  MAX_POLL_OPTIONS,
  MAX_POLL_OPTION_CHARS,
  MAX_POLL_QUESTION_CHARS,
  MAX_QA_QUESTION_CHARS,
  ANONYMOUS_LABEL,
  isAllHandsAction,
  allhandsProblem,
  createPollRecord,
  votePollRecord,
  closePollRecord,
  tallyPoll,
  createQuestionRecord,
  upvoteQuestionRecord,
  answerQuestionRecord,
  rankQuestions,
  maskAuthor,
} from "../../packages/protocol/allhands.js";
import { Records } from "../../packages/protocol/records.js";

// ---- Live Polls ----

test("createPollRecord validates bounds: 2..10 options <= 120 chars, question <= 240 chars", () => {
  const valid = createPollRecord({
    id: "p1",
    question: "Q".repeat(MAX_POLL_QUESTION_CHARS),
    options: Array.from({ length: MAX_POLL_OPTIONS }, (_, i) => `${i}${"a".repeat(MAX_POLL_OPTION_CHARS - 1)}`),
    anonymous: true,
  });
  expect(valid.do).toBe("poll.create");
  expect(valid.options.length).toBe(10);
  expect(valid.anonymous).toBe(true);

  // Too few / too many options
  expect(() => createPollRecord({ id: "p", question: "Hi?", options: ["Only one"] })).toThrow();
  expect(() => createPollRecord({ id: "p", question: "Hi?", options: [] })).toThrow();
  expect(() => createPollRecord({
    id: "p",
    question: "Hi?",
    options: Array.from({ length: MAX_POLL_OPTIONS + 1 }, (_, i) => `Opt ${i}`),
  })).toThrow();

  // Over-length option or empty/whitespace option
  expect(() => createPollRecord({ id: "p", question: "Hi?", options: ["A", "x".repeat(MAX_POLL_OPTION_CHARS + 1)] })).toThrow();
  expect(() => createPollRecord({ id: "p", question: "Hi?", options: ["A", "   "] })).toThrow();

  // Over-length or empty question
  expect(() => createPollRecord({ id: "p", question: "   ", options: ["A", "B"] })).toThrow();
  expect(() => createPollRecord({ id: "p", question: "q".repeat(MAX_POLL_QUESTION_CHARS + 1), options: ["A", "B"] })).toThrow();

  // Invalid id or anonymous flag
  expect(() => createPollRecord({ id: "", question: "Hi?", options: ["A", "B"] })).toThrow();
  expect(() => createPollRecord({ id: "x".repeat(MAX_ID_CHARS + 1), question: "Hi?", options: ["A", "B"] })).toThrow();
  expect(() => createPollRecord({ id: "p", question: "Hi?", options: ["A", "B"], anonymous: /** @type {any} */ ("yes") })).toThrow();
});

test("tallyPoll: strict 1-vote-per-user dedup (latest vote wins), changing vote updates tally cleanly, votes after close ignored", () => {
  const records = [
    // Vote before poll creation is ignored
    votePollRecord({ pollId: "p1", optionIndex: 0, by: "u-early", seq: 1 }),
    createPollRecord({ id: "p1", question: "Lunch?", options: ["Pizza", "Tacos", "Sushi"], by: "u-host", authorName: "Host", at: 100, seq: 2 }),
    votePollRecord({ pollId: "p1", optionIndex: 0, by: "u1", seq: 3 }),
    votePollRecord({ pollId: "p1", optionIndex: 1, by: "u2", seq: 4 }),
    // u1 changes vote from 0 (Pizza) -> 2 (Sushi)
    votePollRecord({ pollId: "p1", optionIndex: 2, by: "u1", seq: 5 }),
    // u2 votes for 1 again (deduped)
    votePollRecord({ pollId: "p1", optionIndex: 1, by: "u2", seq: 6 }),
    // Prototype-key user id is safe
    votePollRecord({ pollId: "p1", optionIndex: 2, by: "__proto__", seq: 7 }),
    // Out-of-range optionIndex is ignored
    { do: "poll.vote", id: "p1", pollId: "p1", optionIndex: 9, by: "u-bad", seq: 8 },
    // Other poll records don't interfere
    createPollRecord({ id: "p2", question: "Other?", options: ["Yes", "No"], by: "u-host", seq: 9 }),
    votePollRecord({ pollId: "p2", optionIndex: 0, by: "u1", seq: 10 }),
    // Close p1
    closePollRecord({ pollId: "p1", by: "u-host", at: 200, seq: 11 }),
    // Votes after close are strictly ignored (both new voters and vote changes)
    votePollRecord({ pollId: "p1", optionIndex: 0, by: "u3", seq: 12 }),
    votePollRecord({ pollId: "p1", optionIndex: 0, by: "u1", seq: 13 }),
    // Repeat close is a no-op (keeps original closedAt/closedBy)
    closePollRecord({ pollId: "p1", by: "u2", at: 999, seq: 14 }),
  ];

  const tally = tallyPoll(records, "p1");
  expect(tally).not.toBeNull();
  expect(tally.id).toBe("p1");
  expect(tally.question).toBe("Lunch?");
  expect(tally.options).toEqual(["Pizza", "Tacos", "Sushi"]);
  expect(tally.closed).toBe(true);
  expect(tally.closedBy).toBe("u-host");
  expect(tally.closedAt).toBe(200);
  expect(tally.counts).toEqual([0, 1, 2]);
  expect(tally.totalVotes).toBe(3);
  expect(tally.results).toEqual([
    { index: 0, label: "Pizza", votes: 0, percent: 0 },
    { index: 1, label: "Tacos", votes: 1, percent: 33.3 },
    { index: 2, label: "Sushi", votes: 2, percent: 66.7 },
  ]);
  expect(Object.getPrototypeOf(tally.voters)).toBe(Object.prototype);
  expect(tally.voters.u1).toBe(2);
  expect(tally.voters.u2).toBe(1);
  expect(tally.voters["__proto__"]).toBe(2);
  expect(tally.voters.u3).toBeUndefined();

  // Unknown poll returns null
  expect(tallyPoll(records, "nonexistent")).toBeNull();
});

test("tallyPoll supports room log entry envelopes { seq, by, name, at, op } and sorts by seq", () => {
  const logEntries = [
    { seq: 3, by: "u1", name: "Alice", at: 30, op: votePollRecord({ pollId: "p1", optionIndex: 1 }) },
    { seq: 1, by: "host", name: "Host", at: 10, op: createPollRecord({ id: "p1", question: "Ship?", options: ["Now", "Later"] }) },
    { seq: 2, by: "u1", name: "Alice", at: 20, op: votePollRecord({ pollId: "p1", optionIndex: 0 }) },
  ];
  const tally = tallyPoll(logEntries, "p1");
  expect(tally.counts).toEqual([0, 1]);
  expect(tally.totalVotes).toBe(1);
  expect(tally.author).toBe("host");
  expect(tally.authorName).toBe("Host");
});

// ---- Audience Q&A ----

test("createQuestionRecord validates question <= 500 chars", () => {
  const ok = createQuestionRecord({ id: "q1", text: "a".repeat(MAX_QA_QUESTION_CHARS), anonymous: true });
  expect(ok.do).toBe("qa.ask");
  expect(ok.text.length).toBe(500);

  expect(() => createQuestionRecord({ id: "q1", text: "a".repeat(MAX_QA_QUESTION_CHARS + 1) })).toThrow();
  expect(() => createQuestionRecord({ id: "q1", text: "   " })).toThrow();
  expect(() => createQuestionRecord({ id: "", text: "Valid?" })).toThrow();
});

test("rankQuestions: 1-upvote-per-user toggle dedup, sorted by (answered asc, upvotes desc, seq asc)", () => {
  const records = [
    createQuestionRecord({ id: "q1", text: "First question", by: "u1", authorName: "Alice", at: 10, seq: 1 }),
    createQuestionRecord({ id: "q2", text: "Second question", by: "u2", authorName: "Bob", at: 20, seq: 2 }),
    createQuestionRecord({ id: "q3", text: "Third question", by: "u3", authorName: "Cara", at: 30, seq: 3 }),
    createQuestionRecord({ id: "q4", text: "Fourth question", by: "u4", authorName: "Dan", at: 40, seq: 4 }),

    // q2 gets 2 upvotes (u1, u3)
    upvoteQuestionRecord({ questionId: "q2", by: "u1", seq: 5 }),
    upvoteQuestionRecord({ questionId: "q2", by: "u3", seq: 6 }),

    // q3 gets 3 upvotes, then u1 toggles off -> 2 upvotes (same as q2, higher seq)
    upvoteQuestionRecord({ questionId: "q3", by: "u1", seq: 7 }),
    upvoteQuestionRecord({ questionId: "q3", by: "u2", seq: 8 }),
    upvoteQuestionRecord({ questionId: "q3", by: "u4", seq: 9 }),
    upvoteQuestionRecord({ questionId: "q3", by: "u1", seq: 10 }), // toggle off!

    // q1 gets 3 upvotes, then marked answered -> must sort AFTER all unanswered questions!
    upvoteQuestionRecord({ questionId: "q1", by: "u2", seq: 11 }),
    upvoteQuestionRecord({ questionId: "q1", by: "u3", seq: 12 }),
    upvoteQuestionRecord({ questionId: "q1", by: "u4", seq: 13 }),
    answerQuestionRecord({ questionId: "q1", by: "host", at: 100, seq: 14 }),

    // q4 has 0 upvotes; explicit on: true / false idempotency check
    upvoteQuestionRecord({ questionId: "q4", on: true, by: "u1", seq: 15 }),
    upvoteQuestionRecord({ questionId: "q4", on: true, by: "u1", seq: 16 }), // stays 1
    upvoteQuestionRecord({ questionId: "q4", on: false, by: "u1", seq: 17 }), // back to 0
  ];

  const ranked = rankQuestions(records);
  expect(ranked.map(q => q.id)).toEqual(["q2", "q3", "q4", "q1"]);
  expect(ranked.map(q => ({ id: q.id, answered: q.answered, upvotes: q.upvotes, seq: q.seq }))).toEqual([
    { id: "q2", answered: false, upvotes: 2, seq: 2 },
    { id: "q3", answered: false, upvotes: 2, seq: 3 },
    { id: "q4", answered: false, upvotes: 0, seq: 4 },
    { id: "q1", answered: true, upvotes: 3, seq: 1 },
  ]);
  expect(ranked[3].answeredBy).toBe("host");
  expect(ranked[3].answeredAt).toBe(100);
});

// ---- Anonymous Mode (#15) ----

test("maskAuthor masks author/authorName to 'Anonymous' when anonymous && !revealed, keeps isMine, reveals cleanly", () => {
  const item = { id: "q1", text: "Honest feedback", author: "u1", authorName: "Alice", by: "u1", name: "Alice" };

  // Anonymous & unrevealed, another viewer
  const otherView = maskAuthor(item, { anonymous: true, viewerUserId: "u2", revealed: false });
  expect(otherView).toEqual({
    id: "q1",
    text: "Honest feedback",
    author: ANONYMOUS_LABEL,
    authorName: ANONYMOUS_LABEL,
    by: ANONYMOUS_LABEL,
    name: ANONYMOUS_LABEL,
    isMine: false,
  });

  // Anonymous & unrevealed, author viewing own item -> still masked, but isMine: true
  const ownView = maskAuthor(item, { anonymous: true, viewerUserId: "u1", revealed: false });
  expect(ownView.author).toBe("Anonymous");
  expect(ownView.authorName).toBe("Anonymous");
  expect(ownView.by).toBe("Anonymous");
  expect(ownView.name).toBe("Anonymous");
  expect(ownView.isMine).toBe(true);

  // Anonymous & revealed -> real authors revealed cleanly
  const revealedOther = maskAuthor(item, { anonymous: true, viewerUserId: "u2", revealed: true });
  expect(revealedOther.author).toBe("u1");
  expect(revealedOther.authorName).toBe("Alice");
  expect(revealedOther.by).toBe("u1");
  expect(revealedOther.name).toBe("Alice");
  expect(revealedOther.isMine).toBe(false);

  const revealedOwn = maskAuthor(item, { anonymous: true, viewerUserId: "u1", revealed: true });
  expect(revealedOwn.author).toBe("u1");
  expect(revealedOwn.authorName).toBe("Alice");
  expect(revealedOwn.isMine).toBe(true);

  // Non-anonymous -> real authors preserved
  const plain = maskAuthor(item, { anonymous: false, viewerUserId: "u2", revealed: false });
  expect(plain.author).toBe("u1");
  expect(plain.authorName).toBe("Alice");
  expect(plain.isMine).toBe(false);

  // Non-boolean truthy revealed value (e.g. "false") MUST NOT bypass masking
  const badRevealed = maskAuthor(item, { anonymous: true, viewerUserId: "u2", revealed: /** @type {any} */ ("false") });
  expect(badRevealed.author).toBe("Anonymous");
  expect(badRevealed.authorName).toBe("Anonymous");
  expect(badRevealed.by).toBe("Anonymous");
  expect(badRevealed.name).toBe("Anonymous");

  // Input item was never mutated
  expect(item.author).toBe("u1");
  expect(item.authorName).toBe("Alice");

  // Null/non-object input handled safely
  expect(maskAuthor(/** @type {any} */ (null), { anonymous: true })).toBeNull();
});

// ---- Validation & Records Integration ----

test("allhandsProblem rejects unknown fields, mismatched ids, and out-of-bounds payloads", () => {
  expect(isAllHandsAction("poll.create")).toBe(true);
  expect(isAllHandsAction("thread")).toBe(false);

  expect(allhandsProblem({ do: "poll.create", id: "p1", question: "Q?", options: ["A", "B"], extra: 1 })).toMatchObject({ code: "bad-op" });
  expect(allhandsProblem({ do: "poll.vote", id: "p1", pollId: "p2", optionIndex: 0 })).toMatchObject({ code: "bad-op" });
  expect(allhandsProblem({ do: "poll.vote", pollId: "p1", optionIndex: -1 })).toMatchObject({ code: "bad-op" });
  expect(allhandsProblem({ do: "poll.vote", pollId: "p1", optionIndex: 1.5 })).toMatchObject({ code: "bad-op" });
  expect(allhandsProblem({ do: "poll.create", id: "p1", question: "q".repeat(241), options: ["A", "B"] })).toMatchObject({ code: "limit" });
  expect(allhandsProblem({ do: "qa.ask", id: "q1", text: "x".repeat(501) })).toMatchObject({ code: "limit" });
  expect(allhandsProblem({ do: "qa.upvote", id: "q1", questionId: "q2" })).toMatchObject({ code: "bad-op" });
  expect(allhandsProblem({ do: "qa.answer", questionId: "q1", answered: "yes" })).toMatchObject({ code: "bad-op" });
});

test("Records validates, applies, snapshots, and restores poll & Q&A actions with exact chars accounting", () => {
  const r = new Records();

  // Backwards-compatible snapshot when no polls/questions exist
  expect(r.toJSON()).toEqual({ threads: [] });

  // Only moderators can create polls
  const createPoll = createPollRecord({ id: "p1", question: "Theme?", options: ["Light", "Dark"] });
  expect(r.check(createPoll, "u-com", "commenter")).toMatchObject({ code: "forbidden" });
  expect(r.check(createPoll, "u-ed", "editor")).toBeNull();
  expect(r.apply(createPoll, "u-ed", 10, "Ed")).toBe(true);

  // Duplicate poll id refused
  expect(r.check(createPoll, "u-ed", "editor")).toMatchObject({ code: "bad-op" });

  // Voting: out-of-range optionIndex refused; valid votes deduped
  expect(r.check(votePollRecord({ pollId: "p1", optionIndex: 2 }), "u-com", "commenter")).toMatchObject({ code: "bad-op" });
  expect(r.check(votePollRecord({ pollId: "p1", optionIndex: 0 }), "u-com", "commenter")).toBeNull();
  expect(r.apply(votePollRecord({ pollId: "p1", optionIndex: 0 }), "u-com", 11, "Cy")).toBe(true);
  // Repeating same vote is a no-op
  expect(r.apply(votePollRecord({ pollId: "p1", optionIndex: 0 }), "u-com", 12, "Cy")).toBe(false);
  // Changing vote updates cleanly
  expect(r.apply(votePollRecord({ pollId: "p1", optionIndex: 1 }), "u-com", 13, "Cy")).toBe(true);

  // Closing poll: non-moderator non-creator refused; creator/moderator succeeds
  const closePoll = closePollRecord({ pollId: "p1" });
  expect(r.check(closePoll, "u-com", "commenter")).toMatchObject({ code: "forbidden" });
  expect(r.check(closePoll, "u-ed", "editor")).toBeNull();
  expect(r.apply(closePoll, "u-ed", 14, "Ed")).toBe(true);
  // Vote after close is accepted by check (no-op) and ignored by apply
  expect(r.check(votePollRecord({ pollId: "p1", optionIndex: 0 }), "u-ann", "annotator")).toBeNull();
  expect(r.apply(votePollRecord({ pollId: "p1", optionIndex: 0 }), "u-ann", 15, "Ann")).toBe(false);

  // Q&A: anyone who writes records can ask & upvote; only moderators can mark answered
  const ask = createQuestionRecord({ id: "q1", text: "Will this be recorded?", anonymous: true });
  expect(r.check(ask, "u-com", "commenter")).toBeNull();
  expect(r.apply(ask, "u-com", 20, "Cy")).toBe(true);

  const up = upvoteQuestionRecord({ questionId: "q1" });
  expect(r.check(up, "u-ann", "annotator")).toBeNull();
  expect(r.apply(up, "u-ann", 21, "Ann")).toBe(true);
  expect(r.apply(up, "u-ann", 22, "Ann")).toBe(false === false); // toggles off -> returns true!
  expect(r.apply(up, "u-ann", 23, "Ann")).toBe(true);             // toggles back on!

  const ans = answerQuestionRecord({ questionId: "q1", answered: true });
  expect(r.check(ans, "u-com", "commenter")).toMatchObject({ code: "forbidden" });
  expect(r.check(ans, "u-own", "owner")).toBeNull();
  expect(r.apply(ans, "u-own", 24, "Olga")).toBe(true);
  expect(r.apply(ans, "u-own", 25, "Olga")).toBe(false); // repeat is a no-op

  // Board-wide ID uniqueness across threads, comments, polls, and questions
  expect(r.check(createQuestionRecord({ id: "p1", text: "Collide with poll?" }), "u-com", "commenter")).toMatchObject({ code: "bad-op" });
  expect(r.check(createPollRecord({ id: "q1", question: "Collide with question?", options: ["A", "B"] }), "u-ed", "editor")).toMatchObject({ code: "bad-op" });
  expect(r.check({ do: "thread", id: "p1", anchor: { point: { x: 0, y: 0 } }, text: "Collide with poll" }, "u-com", "commenter")).toMatchObject({ code: "bad-op" });
  expect(r.apply(createQuestionRecord({ id: "p1", text: "Collide with poll?" }), "u-com", 26, "Cy")).toBe(false);

  // Round-trip snapshot preserves state and exact chars count
  const snap = JSON.parse(JSON.stringify(r.toJSON()));
  const rebuilt = new Records(snap);
  expect(rebuilt.toJSON()).toEqual(r.toJSON());
  expect(rebuilt.chars).toBe(r.chars);
});
