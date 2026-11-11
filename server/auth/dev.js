// Dev tokens: a fixed table of token → identity, for local runs and load tests. OFF unless the caller passes
// `{ enabled: true, tokens }` explicitly (`tokens` a plain object or a Map; every entry needs a name); with no config, or enabled without a table, every token is refused.
// Dev users are namespaced "dev:<name>", so they can never collide with a Google user ("google:<sub>").

/** @typedef {import("./oidc.js").Identity} Identity */

/** @param {{ enabled?: boolean, tokens?: Record<string, { name: string, email?: string, domain?: string }> }} [config] */
export function devAuth(config) {
  const on = config?.enabled === true && config.tokens && typeof config.tokens === "object";
  const table = on ? new Map(config.tokens instanceof Map ? config.tokens : Object.entries(config.tokens)) : new Map();
  // Every entry needs its own name, or two entries would share the user "dev:undefined".
  for (const [tok, t] of table)
    if (typeof t?.name !== "string" || !/^[A-Za-z0-9_.@-]{1,64}$/.test(t.name)) throw new Error(`dev: token entry needs a name (${String(tok).slice(0, 4)}…)`);
  return {
    enabled: !!on,
    /** @returns {Promise<Identity|null>} */
    async verify(token) {
      if (!on || typeof token !== "string" || !table.has(token)) return null;
      const t = table.get(token);
      return {
        user: "dev:" + t.name,
        name: t.name,
        email: t.email ? t.email.toLowerCase() : null,
        domain: t.domain ? t.domain.toLowerCase() : null,
      };
    },
  };
}
