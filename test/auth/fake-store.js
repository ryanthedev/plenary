// A fake Store with only the board lookup the gateway awaits (PROTOCOL.md § Auth), backed by the registry, plus a
// stand-in gateway hello check: verify → board → role, all three awaited before anything reaches a room.
export const fakeStore = registry => ({ board: id => registry.board(id) });

/** @returns {Promise<{ user: string, role: string, client: string } | { error: "auth" }>} */
export async function gatewayHello(msg, { auth, store }) {
  const id = await auth.verify(msg.token);
  if (!id) return { error: "auth" };
  const b = await store.board(msg.board);
  if (!b) return { error: "auth" };
  const role = await auth.role(id, msg.board);
  if (!role) return { error: "auth" };
  return { user: id.user, role, client: msg.client };
}
