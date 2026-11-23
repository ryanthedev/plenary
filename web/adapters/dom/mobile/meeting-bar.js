// @ts-check
// Unified Meeting Bar & Epic #79 Mobile Touch Sheets (DOM adapter).
// Renders #top-stack, #meeting-bar, #context-bar, plus touch sheets for:
// - Shared Timer pill & sheet
// - Dot Voting (Canvas-Tap + Vote as List toggle + ranked results)
// - Anonymous pre-send cue
// - Audience Q&A & Live Polls full-height sheet (48px poll buttons, 44x44px Q&A upvote targets)

import { h, replace } from "../dom.js";
import { announce } from "../focus.js";
import {
  computeMeetingBarLayout,
  formatTimerClock,
  rankVotingResults,
  sortQaQuestions,
  computePollTallies,
  anonymousCueText,
} from "../../../core/mobile/meeting-bar.js";

const TIMER_PRESETS_MS = [60_000, 180_000, 300_000, 600_000];

/**
 * Mount the unified mobile meeting bar and Epic #79 touch sheets.
 * @param {{
 *   host: HTMLElement,
 *   sheetHost?: HTMLElement,
 *   state: any,
 *   viewport?: { width: number, height: number, orientation?: "portrait" | "landscape", topbarHeightPx?: number },
 *   handlers?: {
 *     onStop?: () => void,
 *     onUnfollow?: () => void,
 *     onSlideStep?: (delta: -1 | 1) => void,
 *     onTimerStart?: (durationMs: number) => void,
 *     onTimerPause?: () => void,
 *     onTimerReset?: () => void,
 *     onTimerAddMinute?: () => void,
 *     onToggleAnonymous?: (next: boolean) => void,
 *     onVoteModeChange?: (mode: "canvas" | "list") => void,
 *     onVoteCast?: (candidateId: string, delta: 1 | -1) => void,
 *     onPollVote?: (pollId: string, optionId: string) => void,
 *     onQaUpvote?: (questionId: string) => void,
 *     onQaSubmit?: (text: string, anonymous: boolean) => void,
 *   },
 * }} opts
 */
export function mountMobileMeetingBar({
  host,
  sheetHost = host,
  state: initialState = {},
  viewport: initialViewport = { width: 360, height: 667 },
  handlers = {},
}) {
  let state = { ...initialState };
  let viewport = { ...initialViewport };
  /** @type {null | "overflow" | "timer" | "voting" | "qa-polls" | "anon"} */
  let activeSheet = null;
  /** @type {"polls" | "qa"} */
  let qaPollsTab = "polls";
  /** @type {"vote" | "results"} */
  let votingTab = "vote";
  let qaDraft = "";
  let lastOpener = null;

  const meetingBar = h("div.meeting-bar", {
    id: "meeting-bar",
    role: "toolbar",
    "aria-label": "Meeting controls",
  });
  const contextBar = h("div.context-bar", {
    id: "context-bar",
    role: "region",
    "aria-label": "Active session context",
    hidden: true,
  });
  const topStack = h("div.top-stack", { id: "top-stack" }, meetingBar, contextBar);

  const sheetBackdrop = h("div.mobile-meeting-backdrop", {
    "aria-hidden": "true",
    hidden: true,
    onclick: () => closeSheet(),
  });
  const sheetEl = h("div.mobile-meeting-sheet", {
    role: "dialog",
    "aria-modal": "true",
    "aria-label": "Meeting sheet",
    tabindex: "-1",
    hidden: true,
    onkeydown: e => {
      if (e.key === "Escape") {
        e.preventDefault?.();
        closeSheet();
      }
    },
  });

  host.append(topStack);
  sheetHost.append(sheetBackdrop, sheetEl);

  function getLayout() {
    return computeMeetingBarLayout(state, viewport);
  }

  /** @param {string} itemId @param {any} [opener] */
  function activateItem(itemId, opener = null) {
    lastOpener = opener ?? lastOpener;
    if (itemId === "stop") {
      if (state.following) handlers.onUnfollow?.();
      else handlers.onStop?.();
      return;
    }
    if (itemId === "follow") {
      handlers.onUnfollow?.();
      return;
    }
    if (itemId === "slides") {
      handlers.onSlideStep?.(1);
      return;
    }
    if (itemId === "timer") {
      openSheet("timer", opener);
      return;
    }
    if (itemId === "voting") {
      votingTab = state.voting?.phase === "results" ? "results" : "vote";
      openSheet("voting", opener);
      return;
    }
    if (itemId === "polls") {
      qaPollsTab = "polls";
      openSheet("qa-polls", opener);
      return;
    }
    if (itemId === "qa") {
      qaPollsTab = "qa";
      openSheet("qa-polls", opener);
      return;
    }
    if (itemId === "anon") {
      openSheet("anon", opener);
    }
  }

  /** @param {"overflow" | "timer" | "voting" | "qa-polls" | "anon"} kind @param {any} [opener] */
  function openSheet(kind, opener = null) {
    if (opener) lastOpener = opener;
    activeSheet = kind;
    renderSheet();
    sheetEl.focus?.();
  }

  function closeSheet() {
    if (!activeSheet) return;
    activeSheet = null;
    sheetBackdrop.hidden = true;
    sheetEl.hidden = true;
    replace(sheetEl);
    lastOpener?.focus?.();
    lastOpener = null;
  }

  function renderAnonymousCueBanner(compact = false) {
    const cue = anonymousCueText(Boolean(state.anonymous), state.displayName ?? null);
    return h("div", {
      class: `anon-presend-cue${cue.anonymous ? " is-anon" : ""}${compact ? " is-compact" : ""}`,
      role: "status",
      "data-anon-cue": cue.anonymous ? "anonymous" : "named",
    },
    h("span.anon-cue-badge", {}, cue.anonymous ? "🕵️ Anonymous" : "👤 Named"),
    h("span.anon-cue-text", {}, cue.detail),
    handlers.onToggleAnonymous
      ? h("button.btn.ghost.anon-cue-toggle", {
        type: "button",
        "aria-pressed": cue.anonymous ? "true" : "false",
        onclick: () => {
          const next = !Boolean(state.anonymous);
          state = { ...state, anonymous: next };
          handlers.onToggleAnonymous?.(next);
          announce(next ? "Anonymous mode enabled." : "Anonymous mode disabled.");
          render();
        },
      }, cue.anonymous ? "Use name" : "Go anonymous")
      : null);
  }

  function renderOverflowSheet(layout) {
    return h("div.meeting-sheet-body", { "data-sheet-kind": "overflow" },
      h("div.sheet-grabber", { "aria-hidden": "true" }),
      h("div.meeting-sheet-head", {},
        h("h3.meeting-sheet-title", {}, "More meeting tools"),
        h("button.btn.ghost.meeting-sheet-close", { type: "button", "aria-label": "Close", onclick: closeSheet }, "✕")),
      h("div.meeting-overflow-list", { role: "group", "aria-label": "Collapsed meeting tools" },
        layout.overflow.map(item => h("button.sheet-action-row.meeting-overflow-row", {
          type: "button",
          "data-overflow-item": item.id,
          "aria-label": item.label,
          onclick: () => activateItem(item.id),
        },
        h("span.meeting-overflow-label", {}, item.label),
        item.badge ? h("span.badge", {}, item.badge) : null))));
  }

  function renderTimerSheet() {
    const t = state.timer ?? { status: "idle", remainingMs: 300_000, durationMs: 300_000 };
    const canControl = state.role !== "viewer";
    const isRunning = t.status === "running" || t.status === "overtime";
    const clockText = formatTimerClock(t.remainingMs ?? 0);

    return h("div.meeting-sheet-body", { "data-sheet-kind": "timer" },
      h("div.sheet-grabber", { "aria-hidden": "true" }),
      h("div.meeting-sheet-head", {},
        h("h3.meeting-sheet-title", {}, "Shared Timer"),
        h("button.btn.ghost.meeting-sheet-close", { type: "button", "aria-label": "Close timer", onclick: closeSheet }, "✕")),
      h("div.timer-sheet-readout", {
        class: `timer-sheet-readout${t.status === "overtime" ? " is-overtime" : ""}`,
        role: "timer",
        "aria-live": "off",
        "data-timer-readout": clockText,
      }, clockText),
      canControl
        ? h("div.timer-presets", { role: "group", "aria-label": "Timer presets" },
          TIMER_PRESETS_MS.map(ms => h("button.btn.timer-preset-btn", {
            type: "button",
            "data-timer-preset": String(ms),
            onclick: () => {
              state = { ...state, timer: { status: "running", remainingMs: ms, durationMs: ms } };
              handlers.onTimerStart?.(ms);
              render();
            },
          }, `${Math.round(ms / 60_000)}m`)))
        : h("p.muted", {}, "Timer controlled by the session facilitator."),
      canControl
        ? h("div.timer-controls", {},
          h("button.btn.primary.timer-ctrl-btn", {
            type: "button",
            "data-timer-action": isRunning ? "pause" : "start",
            onclick: () => {
              if (isRunning) {
                state = { ...state, timer: { ...t, status: "paused" } };
                handlers.onTimerPause?.();
              } else {
                const dur = t.remainingMs > 0 ? t.remainingMs : (t.durationMs || 300_000);
                state = { ...state, timer: { ...t, status: "running", remainingMs: dur } };
                handlers.onTimerStart?.(dur);
              }
              render();
            },
          }, isRunning ? "Pause" : "Start"),
          h("button.btn.timer-ctrl-btn", {
            type: "button",
            "data-timer-action": "add-min",
            onclick: () => {
              state = { ...state, timer: { ...t, remainingMs: (t.remainingMs ?? 0) + 60_000 } };
              handlers.onTimerAddMinute?.();
              render();
            },
          }, "+1m"),
          h("button.btn.ghost.timer-ctrl-btn", {
            type: "button",
            "data-timer-action": "reset",
            onclick: () => {
              const dur = t.durationMs || 300_000;
              state = { ...state, timer: { status: "idle", remainingMs: dur, durationMs: dur } };
              handlers.onTimerReset?.();
              render();
            },
          }, "Reset"))
        : null);
  }

  function renderVotingSheet() {
    const v = state.voting ?? { active: false, mode: "canvas", remainingDots: 0, totalDots: 5, phase: "voting", candidates: [] };
    const mode = v.mode === "list" ? "list" : "canvas";
    const candidates = Array.isArray(v.candidates) ? v.candidates : [];
    const ranked = rankVotingResults(candidates);
    const showResults = votingTab === "results" || v.phase === "results";

    return h("div.meeting-sheet-body", { "data-sheet-kind": "voting" },
      h("div.sheet-grabber", { "aria-hidden": "true" }),
      h("div.meeting-sheet-head", {},
        h("h3.meeting-sheet-title", {}, showResults ? "Voting Results" : "Dot Voting"),
        h("span.badge.voting-dots-badge", { "data-remaining-dots": String(v.remainingDots ?? 0) },
          `${Math.max(0, v.remainingDots ?? 0)} / ${v.totalDots ?? 0} dots left`),
        h("button.btn.ghost.meeting-sheet-close", { type: "button", "aria-label": "Close voting", onclick: closeSheet }, "✕")),
      h("div.voting-mode-bar", { role: "tablist", "aria-label": "Voting view" },
        h("button.btn.voting-mode-btn", {
          type: "button",
          role: "tab",
          "aria-selected": !showResults && mode === "canvas" ? "true" : "false",
          "data-vote-mode": "canvas",
          onclick: () => {
            votingTab = "vote";
            state = { ...state, voting: { ...v, mode: "canvas" } };
            handlers.onVoteModeChange?.("canvas");
            render();
          },
        }, "Canvas-Tap"),
        h("button.btn.voting-mode-btn", {
          type: "button",
          role: "tab",
          "aria-selected": !showResults && mode === "list" ? "true" : "false",
          "data-vote-mode": "list",
          onclick: () => {
            votingTab = "vote";
            state = { ...state, voting: { ...v, mode: "list" } };
            handlers.onVoteModeChange?.("list");
            render();
          },
        }, "Vote as List"),
        h("button.btn.voting-mode-btn", {
          type: "button",
          role: "tab",
          "aria-selected": showResults ? "true" : "false",
          "data-vote-mode": "results",
          onclick: () => {
            votingTab = "results";
            render();
          },
        }, "Results")),
      showResults
        ? h("ol.voting-results-list", { "aria-label": "Ranked voting results" },
          ranked.length
            ? ranked.map(r => h("li.voting-result-row", { "data-rank": String(r.rank), "data-candidate": r.id },
              h("span.voting-rank-badge", {}, `#${r.rank}`),
              h("div.voting-result-main", {},
                h("div.voting-result-top", {},
                  h("span.voting-result-label", {}, r.label),
                  h("strong.voting-result-count", {}, `${r.votes} vote${r.votes === 1 ? "" : "s"}`)),
                h("div.voting-result-track", { "aria-hidden": "true" },
                  h("div.voting-result-fill", { style: { width: `${Math.round(r.share * 100)}%` } })))))
            : h("li.muted", {}, "No votes cast yet."))
        : mode === "canvas"
          ? h("div.voting-canvas-hint", { "data-canvas-tap-hint": "true" },
            h("p", {}, "Tap any card or frame on the board to place a vote dot."),
            h("button.btn.primary.voting-switch-list", {
              type: "button",
              "data-action": "switch-vote-list",
              onclick: () => {
                state = { ...state, voting: { ...v, mode: "list" } };
                handlers.onVoteModeChange?.("list");
                render();
              },
            }, "Switch to Vote as List"))
          : h("ul.voting-list", { "aria-label": "Vote candidates" },
            candidates.length
              ? candidates.map(c => {
                const mine = Math.max(0, Number(c.mine) || 0);
                const canAdd = (v.remainingDots ?? 0) > 0;
                return h("li.voting-list-row", { "data-candidate": c.id },
                  h("span.voting-list-label", {}, c.label),
                  h("div.voting-list-actions", {},
                    h("button.btn.ghost.voting-step-btn", {
                      type: "button",
                      "aria-label": `Remove vote from ${c.label}`,
                      "aria-disabled": mine > 0 ? "false" : "true",
                      "data-vote-dec": c.id,
                      onclick: () => {
                        if (mine <= 0) return;
                        castVoteLocal(c.id, -1);
                      },
                    }, "−"),
                    h("span.voting-mine-count", { "aria-label": `${mine} votes placed` }, String(mine)),
                    h("button.btn.primary.voting-step-btn", {
                      type: "button",
                      "aria-label": `Add vote to ${c.label}`,
                      "aria-disabled": canAdd ? "false" : "true",
                      "data-vote-inc": c.id,
                      onclick: () => {
                        if (!canAdd) return;
                        castVoteLocal(c.id, 1);
                      },
                    }, "+")));
              })
              : h("li.muted", {}, "No votable items on this board.")));
  }

  /** @param {string} candidateId @param {1 | -1} delta */
  function castVoteLocal(candidateId, delta) {
    const v = state.voting;
    if (!v) return;
    const candidates = (v.candidates ?? []).map(c => {
      if (c.id !== candidateId) return c;
      return {
        ...c,
        mine: Math.max(0, (Number(c.mine) || 0) + delta),
        votes: Math.max(0, (Number(c.votes) || 0) + delta),
      };
    });
    const remainingDots = Math.max(0, (v.remainingDots ?? 0) - delta);
    state = { ...state, voting: { ...v, candidates, remainingDots } };
    handlers.onVoteCast?.(candidateId, delta);
    announce(delta > 0 ? `Vote added. ${remainingDots} dots left.` : `Vote removed. ${remainingDots} dots left.`);
    render();
  }

  function renderQaPollsSheet() {
    const polls = Array.isArray(state.polls?.items) ? state.polls.items : [];
    const questions = sortQaQuestions(Array.isArray(state.qa?.items) ? state.qa.items : []);

    const qaInput = /** @type {HTMLInputElement} */ (h("input.field.qa-compose-input", {
      type: "text",
      "aria-label": "Ask a question",
      placeholder: state.anonymous ? "Ask anonymously…" : "Ask a question…",
      maxLength: 280,
      value: qaDraft,
      style: { fontSize: "16px" },
      oninput: e => { qaDraft = e.target.value; },
      onkeydown: e => {
        if (e.key === "Enter") {
          e.preventDefault?.();
          submitQa();
        }
      },
    }));

    function submitQa() {
      const text = String(qaDraft ?? "").trim();
      if (!text) return;
      const anon = Boolean(state.anonymous);
      const nextItem = {
        id: `q-${questions.length + 1}`,
        text,
        author: anon ? "Anonymous" : (state.displayName || "You"),
        anonymous: anon,
        upvotes: 1,
        upvoted: true,
        answered: false,
        createdAt: questions.length + 1,
      };
      qaDraft = "";
      state = {
        ...state,
        qa: {
          ...(state.qa ?? {}),
          open: true,
          count: (state.qa?.count ?? questions.length) + 1,
          items: [...questions, nextItem],
        },
      };
      handlers.onQaSubmit?.(text, anon);
      announce(anon ? "Anonymous question posted." : "Question posted.");
      render();
    }

    const pollsView = h("div.mobile-polls-panel", { "data-panel": "polls" },
      renderAnonymousCueBanner(true),
      polls.length
        ? polls.map(poll => {
          const tally = computePollTallies(poll);
          const showTallies = Boolean(poll.selectedOptionId || poll.closed);
          return h("section.mobile-poll-card", { "data-poll-id": poll.id, "aria-label": poll.question },
            h("div.mobile-poll-head", {},
              h("h4.mobile-poll-question", {}, poll.question),
              h("span.badge", {}, poll.closed ? "Closed" : `${tally.totalVotes} vote${tally.totalVotes === 1 ? "" : "s"}`)),
            h("div.mobile-poll-options", { role: "group", "aria-label": poll.question },
              tally.options.map(opt => h("button.poll-option-btn", {
                type: "button",
                class: `poll-option-btn${opt.selected ? " is-selected" : ""}${opt.leading && showTallies ? " is-leading" : ""}`,
                "data-poll-id": poll.id,
                "data-poll-option": opt.id,
                "aria-pressed": opt.selected ? "true" : "false",
                "aria-disabled": poll.closed ? "true" : "false",
                onclick: () => {
                  if (poll.closed) return;
                  const nextPolls = polls.map(p => {
                    if (p.id !== poll.id) return p;
                    const prev = p.selectedOptionId;
                    return {
                      ...p,
                      selectedOptionId: opt.id,
                      options: p.options.map(o => ({
                        ...o,
                        votes: o.id === opt.id
                          ? (prev === opt.id ? o.votes : o.votes + 1)
                          : (prev === o.id ? Math.max(0, o.votes - 1) : o.votes),
                      })),
                    };
                  });
                  state = { ...state, polls: { ...(state.polls ?? {}), voted: true, items: nextPolls } };
                  handlers.onPollVote?.(poll.id, opt.id);
                  announce(`Voted for ${opt.label}.`);
                  render();
                },
              },
              h("span.poll-option-bar", { "aria-hidden": "true", style: { width: showTallies ? `${opt.pct}%` : "0%" } }),
              h("span.poll-option-label", {}, opt.label),
              showTallies ? h("span.poll-option-pct", {}, `${opt.pct}%`) : null))));
        })
        : h("p.muted", {}, "No active polls right now."));

    const qaView = h("div.mobile-qa-panel", { "data-panel": "qa" },
      h("ul.mobile-qa-list", { "aria-label": "Audience questions" },
        questions.length
          ? questions.map(q => h("li.mobile-qa-card", { "data-question-id": q.id },
            h("button.qa-upvote-btn", {
              type: "button",
              class: `qa-upvote-btn${q.upvoted ? " is-upvoted" : ""}`,
              "data-qa-upvote": q.id,
              "aria-pressed": q.upvoted ? "true" : "false",
              "aria-label": `${q.upvoted ? "Remove upvote from" : "Upvote"} question: ${q.text}`,
              onclick: () => {
                const nextItems = questions.map(item => {
                  if (item.id !== q.id) return item;
                  const upvoted = !item.upvoted;
                  return {
                    ...item,
                    upvoted,
                    upvotes: Math.max(0, (Number(item.upvotes) || 0) + (upvoted ? 1 : -1)),
                  };
                });
                state = { ...state, qa: { ...(state.qa ?? {}), items: nextItems } };
                handlers.onQaUpvote?.(q.id);
                render();
              },
            },
            h("span.qa-upvote-arrow", { "aria-hidden": "true" }, "▲"),
            h("span.qa-upvote-count", {}, String(q.upvotes ?? 0))),
            h("div.mobile-qa-body", {},
              h("p.mobile-qa-text", {}, q.text),
              h("div.mobile-qa-meta", {},
                h("span.muted", {}, q.anonymous ? "Anonymous" : (q.author || "Participant")),
                q.answered ? h("span.badge", {}, "Answered") : null))))
          : h("li.muted", {}, "No questions yet. Be the first to ask.")),
      h("div.mobile-qa-compose", {},
        renderAnonymousCueBanner(true),
        h("form.mobile-qa-form", {
          onsubmit: e => {
            e.preventDefault?.();
            submitQa();
          },
        },
        qaInput,
        h("button.btn.primary.qa-submit-btn", { type: "submit", "data-qa-submit": "true" }, "Ask"))));

    return h("div.meeting-sheet-body.mobile-full-sheet", { "data-sheet-kind": "qa-polls" },
      h("div.sheet-grabber", { "aria-hidden": "true" }),
      h("div.meeting-sheet-head", {},
        h("div.qa-polls-tabs", { role: "tablist", "aria-label": "Audience interaction" },
          h("button.btn.qa-polls-tab", {
            type: "button",
            role: "tab",
            "aria-selected": qaPollsTab === "polls" ? "true" : "false",
            "data-tab": "polls",
            onclick: () => { qaPollsTab = "polls"; render(); },
          }, `Polls${polls.length ? ` (${polls.length})` : ""}`),
          h("button.btn.qa-polls-tab", {
            type: "button",
            role: "tab",
            "aria-selected": qaPollsTab === "qa" ? "true" : "false",
            "data-tab": "qa",
            onclick: () => { qaPollsTab = "qa"; render(); },
          }, `Q&A${questions.length ? ` (${questions.length})` : ""}`)),
        h("button.btn.ghost.meeting-sheet-close", { type: "button", "aria-label": "Close Q&A and Polls", onclick: closeSheet }, "✕")),
      qaPollsTab === "polls" ? pollsView : qaView);
  }

  function renderAnonSheet() {
    return h("div.meeting-sheet-body", { "data-sheet-kind": "anon" },
      h("div.sheet-grabber", { "aria-hidden": "true" }),
      h("div.meeting-sheet-head", {},
        h("h3.meeting-sheet-title", {}, "Anonymous Participation"),
        h("button.btn.ghost.meeting-sheet-close", { type: "button", "aria-label": "Close", onclick: closeSheet }, "✕")),
      renderAnonymousCueBanner(false));
  }

  function renderSheet() {
    if (!activeSheet) {
      sheetBackdrop.hidden = true;
      sheetEl.hidden = true;
      return;
    }
    const layout = getLayout();
    sheetBackdrop.hidden = false;
    sheetEl.hidden = false;
    sheetEl.classList.toggle("is-full-height", activeSheet === "qa-polls");
    let body = null;
    if (activeSheet === "overflow") body = renderOverflowSheet(layout);
    else if (activeSheet === "timer") body = renderTimerSheet();
    else if (activeSheet === "voting") body = renderVotingSheet();
    else if (activeSheet === "qa-polls") body = renderQaPollsSheet();
    else if (activeSheet === "anon") body = renderAnonSheet();
    replace(sheetEl, body);
  }

  function renderContextBar(layout) {
    if (!layout.showContextBar) {
      contextBar.hidden = true;
      replace(contextBar);
      return;
    }
    contextBar.hidden = false;
    if (state.voting?.active) {
      const mode = state.voting.mode === "list" ? "list" : "canvas";
      replace(contextBar,
        h("span.context-bar-label", {}, `Voting · ${Math.max(0, state.voting.remainingDots ?? 0)} dots left`),
        h("button.btn.ghost.context-bar-action", {
          type: "button",
          "data-context-action": "toggle-vote-mode",
          onclick: e => {
            const nextMode = mode === "canvas" ? "list" : "canvas";
            state = { ...state, voting: { ...state.voting, mode: nextMode } };
            handlers.onVoteModeChange?.(nextMode);
            if (nextMode === "list") openSheet("voting", e.currentTarget);
            else render();
          },
        }, mode === "canvas" ? "Vote as List" : "Canvas-Tap"));
      return;
    }
    if (state.anonymous) {
      replace(contextBar, renderAnonymousCueBanner(true));
      return;
    }
    if (state.following) {
      replace(contextBar,
        h("span.context-bar-label", {}, `Following ${state.presenterName || "Presenter"}`),
        h("button.btn.ghost.context-bar-action", {
          type: "button",
          "data-context-action": "unfollow",
          onclick: () => handlers.onUnfollow?.(),
        }, "Unfollow"));
    }
  }

  function render() {
    const layout = getLayout();
    topStack.setAttribute("data-orientation", layout.orientation);
    topStack.setAttribute("data-chrome-ratio", layout.chromeRatio.toFixed(3));
    topStack.classList.toggle("is-compact", layout.compact);

    if (!layout.hasBar) {
      meetingBar.hidden = true;
      contextBar.hidden = true;
      replace(meetingBar);
      replace(contextBar);
      renderSheet();
      return;
    }

    meetingBar.hidden = false;
    const pills = layout.visible.map(item => h("button", {
      type: "button",
      class: `meeting-pill tone-${item.tone ?? "default"}${item.active ? " is-active" : ""}`,
      "data-meeting-item": item.id,
      "aria-label": item.label,
      onclick: e => activateItem(item.id, e.currentTarget),
    },
    h("span.meeting-pill-label", {}, layout.compact ? item.shortLabel : item.label),
    item.badge && item.shortLabel !== item.badge ? h("span.meeting-pill-badge", {}, item.badge) : null));

    const overflowBtn = layout.overflow.length
      ? h("button.meeting-pill.meeting-pill-overflow", {
        type: "button",
        "data-meeting-overflow": "true",
        "aria-label": `More meeting tools (${layout.overflow.length})`,
        "aria-haspopup": "dialog",
        onclick: e => openSheet("overflow", e.currentTarget),
      }, `⋯ ${layout.overflow.length}`)
      : null;

    replace(meetingBar, pills, overflowBtn);
    renderContextBar(layout);
    renderSheet();
  }

  render();

  return {
    el: topStack,
    meetingBar,
    contextBar,
    sheetEl,
    getLayout,
    openSheet,
    closeSheet,
    /** @param {any} nextState @param {any} [nextViewport] */
    update(nextState, nextViewport) {
      if (nextState) state = { ...state, ...nextState };
      if (nextViewport) viewport = { ...viewport, ...nextViewport };
      render();
    },
    destroy() {
      closeSheet();
      topStack.remove();
      sheetBackdrop.remove();
      sheetEl.remove();
    },
  };
}
