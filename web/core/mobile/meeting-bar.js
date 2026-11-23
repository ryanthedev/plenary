// @ts-check
// Pure Meeting Bar & Epic #79 mobile layout/state model (ZERO browser globals).
// Implements the priority-collapse model for 360px/375px portrait & landscape viewports
// keeping total top chrome <= 20% of viewport height across Follow, Slide counter, Timer,
// Anonymous cue, Q&A, Polls, Voting, and Stop.

/**
 * @typedef {"follow" | "slides" | "timer" | "anon" | "qa" | "polls" | "voting" | "stop"} MeetingItemId
 *
 * @typedef {{
 *   id: MeetingItemId,
 *   label: string,
 *   shortLabel: string,
 *   widthPx: number,
 *   priority: number,
 *   pinned?: boolean,
 *   badge?: string | null,
 *   active?: boolean,
 *   tone?: "default" | "accent" | "warn" | "danger",
 * }} MeetingBarItem
 *
 * @typedef {{
 *   active?: boolean,
 *   role?: string,
 *   following?: boolean,
 *   presenterName?: string | null,
 *   slideIndex?: number,
 *   slideCount?: number,
 *   timer?: { status?: "idle" | "running" | "paused" | "overtime", remainingMs?: number, durationMs?: number } | null,
 *   anonymous?: boolean,
 *   qa?: { open?: boolean, count?: number, unread?: number } | null,
 *   polls?: { open?: boolean, activeCount?: number, voted?: boolean } | null,
 *   voting?: { active?: boolean, mode?: "canvas" | "list", remainingDots?: number, totalDots?: number, phase?: "voting" | "results" } | null,
 *   canStop?: boolean,
 *   contextBarMode?: "none" | "voting" | "follow" | "anon",
 * }} MeetingBarState
 *
 * @typedef {{
 *   width: number,
 *   height: number,
 *   orientation?: "portrait" | "landscape",
 *   topbarHeightPx?: number,
 * }} ViewportMetrics
 */

/** Maximum share of viewport height allowed for top chrome (#topbar + #meeting-bar + #context-bar). */
export const MAX_CHROME_RATIO = 0.20;

/** Priority order (lower number = higher priority to stay visible on narrow screens). */
export const MEETING_ITEM_PRIORITY = Object.freeze({
  stop: 1,
  follow: 2,
  timer: 3,
  slides: 4,
  voting: 5,
  polls: 6,
  qa: 7,
  anon: 8,
});

const OVERFLOW_BUTTON_PX = 44;
const BAR_HORIZONTAL_PADDING_PX = 16;
const ITEM_GAP_PX = 6;

/**
 * Format a countdown duration in milliseconds as `mm:ss` (or `-mm:ss` when overtime).
 * @param {number} ms
 * @returns {string}
 */
export function formatTimerClock(ms) {
  const n = Number.isFinite(ms) ? ms : 0;
  const neg = n < 0;
  const totalSec = Math.ceil(Math.abs(n) / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const mm = String(mins).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  return `${neg ? "-" : ""}${mm}:${ss}`;
}

/**
 * Build the active candidate items for the unified meeting bar from session state.
 * @param {MeetingBarState} state
 * @returns {MeetingBarItem[]}
 */
export function buildMeetingItems(state) {
  const s = state ?? {};
  /** @type {MeetingBarItem[]} */
  const items = [];

  if (s.following) {
    const who = s.presenterName ? String(s.presenterName).slice(0, 12) : "Presenter";
    items.push({
      id: "follow",
      label: `Following ${who}`,
      shortLabel: "Follow",
      widthPx: 88,
      priority: MEETING_ITEM_PRIORITY.follow,
      active: true,
      tone: "accent",
    });
  }

  if (s.timer && s.timer.status && s.timer.status !== "idle") {
    const clockText = formatTimerClock(s.timer.remainingMs ?? 0);
    items.push({
      id: "timer",
      label: `Timer ${clockText}`,
      shortLabel: clockText,
      widthPx: 72,
      priority: MEETING_ITEM_PRIORITY.timer,
      active: s.timer.status === "running" || s.timer.status === "overtime",
      tone: s.timer.status === "overtime" ? "danger" : s.timer.status === "running" ? "accent" : "default",
      badge: clockText,
    });
  }

  if (Number.isFinite(s.slideCount) && (s.slideCount ?? 0) > 0) {
    const idx = Math.max(1, Math.min(s.slideCount ?? 1, (s.slideIndex ?? 0) + 1));
    const counter = `${idx}/${s.slideCount}`;
    items.push({
      id: "slides",
      label: `Slide ${counter}`,
      shortLabel: counter,
      widthPx: 64,
      priority: MEETING_ITEM_PRIORITY.slides,
      badge: counter,
      tone: "default",
    });
  }

  if (s.voting?.active) {
    const rem = Math.max(0, s.voting.remainingDots ?? 0);
    const isResults = s.voting.phase === "results";
    items.push({
      id: "voting",
      label: isResults ? "Voting results" : `Vote (${rem} left)`,
      shortLabel: isResults ? "Results" : `Vote ${rem}`,
      widthPx: 78,
      priority: MEETING_ITEM_PRIORITY.voting,
      active: true,
      badge: isResults ? "★" : String(rem),
      tone: "accent",
    });
  }

  if (s.polls && (s.polls.open || (s.polls.activeCount ?? 0) > 0)) {
    const count = Math.max(0, s.polls.activeCount ?? 0);
    items.push({
      id: "polls",
      label: count > 0 ? `Polls (${count})` : "Polls",
      shortLabel: "Polls",
      widthPx: 68,
      priority: MEETING_ITEM_PRIORITY.polls,
      active: count > 0 && !s.polls.voted,
      badge: count > 0 ? String(count) : null,
      tone: count > 0 && !s.polls.voted ? "accent" : "default",
    });
  }

  if (s.qa && (s.qa.open || (s.qa.count ?? 0) > 0)) {
    const unread = Math.max(0, s.qa.unread ?? 0);
    const count = Math.max(0, s.qa.count ?? 0);
    items.push({
      id: "qa",
      label: count > 0 ? `Q&A (${count})` : "Q&A",
      shortLabel: "Q&A",
      widthPx: 62,
      priority: MEETING_ITEM_PRIORITY.qa,
      active: unread > 0,
      badge: unread > 0 ? String(unread) : count > 0 ? String(count) : null,
      tone: unread > 0 ? "accent" : "default",
    });
  }

  if (s.anonymous) {
    items.push({
      id: "anon",
      label: "Anonymous mode",
      shortLabel: "Anon",
      widthPx: 64,
      priority: MEETING_ITEM_PRIORITY.anon,
      active: true,
      tone: "warn",
    });
  }

  if (s.canStop || s.following) {
    items.push({
      id: "stop",
      label: s.following ? "Unfollow" : "Stop",
      shortLabel: "Stop",
      widthPx: 58,
      priority: MEETING_ITEM_PRIORITY.stop,
      pinned: true,
      tone: "danger",
    });
  }

  return items.sort((a, b) => a.priority - b.priority);
}

/**
 * Compute priority-collapsed layout for `#top-stack`, `#meeting-bar`, and `#context-bar`.
 * Guarantees `chromeRatio <= 0.20` across portrait (`360×667`, `375×667`) and landscape (`667×360`, `667×375`).
 * @param {MeetingBarState} state
 * @param {ViewportMetrics} viewport
 */
export function computeMeetingBarLayout(state, viewport) {
  const width = Math.max(240, Number(viewport?.width) || 360);
  const height = Math.max(240, Number(viewport?.height) || 667);
  const orientation = viewport?.orientation ?? (width > height ? "landscape" : "portrait");
  const isLandscape = orientation === "landscape";

  const items = buildMeetingItems(state);
  const hasBar = Boolean(state?.active || items.length > 0);

  const maxChromePx = Math.floor(height * MAX_CHROME_RATIO);
  const defaultTopbar = isLandscape ? 36 : 44;
  const topbar = Math.min(
    maxChromePx,
    Number.isFinite(viewport?.topbarHeightPx) ? /** @type {number} */ (viewport.topbarHeightPx) : defaultTopbar,
  );

  // Determine whether a context sub-bar is requested (e.g., voting Canvas-Tap/List bar or anonymous cue).
  const wantsContextBar = hasBar && (
    state?.contextBarMode === "voting" ||
    state?.contextBarMode === "follow" ||
    state?.contextBarMode === "anon" ||
    Boolean(state?.voting?.active)
  );

  let meetingBar = 0;
  let contextBar = 0;

  if (hasBar) {
    const idealBar = isLandscape ? 36 : 44;
    const remainingAfterTop = Math.max(0, maxChromePx - topbar);
    meetingBar = Math.min(idealBar, remainingAfterTop);

    // Only show #context-bar when it fits inside the <=20% viewport chrome budget (never in tight landscape).
    const idealContext = 36;
    const remainingAfterBar = Math.max(0, maxChromePx - topbar - meetingBar);
    if (wantsContextBar && !isLandscape && remainingAfterBar >= idealContext) {
      contextBar = idealContext;
    }
  }

  const total = topbar + meetingBar + contextBar;
  const chromeRatio = total / height;

  // Priority-collapse items to fit available horizontal width.
  const budgetPx = Math.max(120, width - BAR_HORIZONTAL_PADDING_PX);
  const pinned = items.filter(i => i.pinned);
  const regular = items.filter(i => !i.pinned);

  /** @type {MeetingBarItem[]} */
  const visibleRegular = [];
  /** @type {MeetingBarItem[]} */
  const overflow = [];

  const pinnedWidth = pinned.reduce((acc, item) => acc + item.widthPx + ITEM_GAP_PX, 0);
  const totalRegularWidth = regular.reduce((acc, item) => acc + item.widthPx + ITEM_GAP_PX, 0);

  if (pinnedWidth + totalRegularWidth <= budgetPx) {
    visibleRegular.push(...regular);
  } else {
    let used = pinnedWidth + OVERFLOW_BUTTON_PX + ITEM_GAP_PX;
    for (const item of regular) {
      const need = item.widthPx + ITEM_GAP_PX;
      if (used + need <= budgetPx) {
        visibleRegular.push(item);
        used += need;
      } else {
        overflow.push(item);
      }
    }
  }

  const visible = [...visibleRegular, ...pinned];

  return {
    orientation,
    compact: isLandscape || width <= 375,
    hasBar,
    visible,
    overflow,
    showContextBar: contextBar > 0,
    heights: {
      topbar,
      meetingBar,
      contextBar,
      total,
    },
    chromeRatio,
    withinBudget: chromeRatio <= MAX_CHROME_RATIO + 1e-9,
  };
}

/**
 * Rank dot-voting candidates by vote count descending (tie-break alphabetically by label).
 * @param {{ id: string, label: string, votes: number, mine?: number }[]} items
 * @returns {{ id: string, label: string, votes: number, mine: number, rank: number, share: number }[]}
 */
export function rankVotingResults(items) {
  const list = Array.isArray(items) ? items : [];
  const totalVotes = list.reduce((sum, x) => sum + Math.max(0, Number(x?.votes) || 0), 0);
  const sorted = [...list].sort((a, b) => {
    const diff = (Number(b?.votes) || 0) - (Number(a?.votes) || 0);
    if (diff !== 0) return diff;
    return String(a?.label ?? "").localeCompare(String(b?.label ?? ""));
  });
  let currentRank = 0;
  let lastVotes = -1;
  return sorted.map((item, idx) => {
    const votes = Math.max(0, Number(item?.votes) || 0);
    if (votes !== lastVotes) {
      currentRank = idx + 1;
      lastVotes = votes;
    }
    return {
      id: String(item?.id ?? idx),
      label: String(item?.label ?? "Untitled"),
      votes,
      mine: Math.max(0, Number(item?.mine) || 0),
      rank: currentRank,
      share: totalVotes > 0 ? votes / totalVotes : 0,
    };
  });
}

/**
 * Sort Q&A questions: unanswered first, then upvotes descending, then oldest first.
 * @param {{ id: string, text: string, author?: string, anonymous?: boolean, upvotes?: number, upvoted?: boolean, answered?: boolean, createdAt?: number }[]} questions
 */
export function sortQaQuestions(questions) {
  const list = Array.isArray(questions) ? questions : [];
  return [...list].sort((a, b) => {
    const ansDiff = Number(Boolean(a?.answered)) - Number(Boolean(b?.answered));
    if (ansDiff !== 0) return ansDiff;
    const upDiff = (Number(b?.upvotes) || 0) - (Number(a?.upvotes) || 0);
    if (upDiff !== 0) return upDiff;
    return (Number(a?.createdAt) || 0) - (Number(b?.createdAt) || 0);
  });
}

/**
 * Compute live poll option tallies & percentages.
 * @param {{ id: string, question: string, closed?: boolean, selectedOptionId?: string | null, options: { id: string, label: string, votes: number }[] }} poll
 */
export function computePollTallies(poll) {
  const options = Array.isArray(poll?.options) ? poll.options : [];
  const totalVotes = options.reduce((sum, o) => sum + Math.max(0, Number(o?.votes) || 0), 0);
  const maxVotes = options.reduce((m, o) => Math.max(m, Math.max(0, Number(o?.votes) || 0)), 0);
  return {
    totalVotes,
    options: options.map(o => {
      const votes = Math.max(0, Number(o?.votes) || 0);
      const pct = totalVotes > 0 ? Math.round((votes / totalVotes) * 100) : 0;
      return {
        id: String(o.id),
        label: String(o.label ?? ""),
        votes,
        pct,
        selected: poll?.selectedOptionId === o.id,
        leading: maxVotes > 0 && votes === maxVotes,
      };
    }),
  };
}

/**
 * Pre-send anonymity cue copy shown before submitting a Q&A question, poll vote, or comment.
 * @param {boolean} anonymous
 * @param {string | null} [displayName]
 * @returns {{ anonymous: boolean, badge: string, detail: string }}
 */
export function anonymousCueText(anonymous, displayName = null) {
  if (anonymous) {
    return {
      anonymous: true,
      badge: "Anonymous",
      detail: "Posting anonymously — your name is hidden from other participants.",
    };
  }
  const who = displayName && String(displayName).trim() ? String(displayName).trim() : "your account";
  return {
    anonymous: false,
    badge: "Named",
    detail: `Posting as ${who}.`,
  };
}
