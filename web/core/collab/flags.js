// The CEO's open questions (docs/m2/reports/p6-mock.md, "Open questions"), one flag each, at the mock's default.
// Change a default here once the CEO answers; nothing else reads these questions.
export const FLAGS = Object.freeze({
  /** Q1: viewers see only presenters' (owner/editor) cursors, selections and previews. false = every writer's. */
  viewersSeePresentersOnly: true,
  /** Q2: a "follow the presenter" view for viewers. Not built; true only shows that it would go here. */
  followPresenter: false,
  /** Q7: reactions live on comments only (records `react`). There is no reaction on elements or the board. */
  reactionsOnCommentsOnly: true,
});
