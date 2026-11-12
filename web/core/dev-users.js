// Dev tokens for the in-browser rooms: the URL's ?as=<name> picks token dev-<name>, which picks the user and
// role. Never a real credential; the phase-3 server has its own (PLENARY_DEV_TOKENS).
export const DEV_USERS = {
  "dev-ada": { user: "ada", name: "Ada", role: "owner" }, "dev-bo": { user: "bo", name: "Bo", role: "editor" },
  "dev-cy": { user: "cy", name: "Cy", role: "annotator" }, "dev-di": { user: "di", name: "Di", role: "annotator" },
  "dev-ed": { user: "ed", name: "Ed", role: "viewer" }, "dev-fi": { user: "fi", name: "Fi", role: "commenter" },
};
