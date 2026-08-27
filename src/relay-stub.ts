// Shared by index.ts and backfill-worker.ts -- pulled out of index.ts so
// backfill-worker.ts (invoked from index.ts's scheduled()) doesn't have
// to import back from index.ts to get it.
export function relayStub(env: Env) {
  // Exactly one Relay instance for the whole deployment -- see
  // CLAUDE.md "Architecture map". Do not shard.
  const id = env.RELAY.idFromName("relay");
  return env.RELAY.get(id);
}
