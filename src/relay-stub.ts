// The one accessor for the Relay Durable Object, shared by index.ts and
// backfill-worker.ts.
export function relayStub(env: Env) {
  // Exactly one Relay instance per deployment: all storage, ownership and
  // subscriptions live in it, so another id would be a separate, empty
  // relay. Do not shard.
  const id = env.RELAY.idFromName("relay");
  return env.RELAY.get(id);
}
