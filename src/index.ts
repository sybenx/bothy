import { nip11Response } from "./nip11";

export { Relay } from "./relay";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get("Accept") === "application/nostr+json") {
      return nip11Response(env);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      // Exactly one Relay instance for the whole deployment -- see
      // CLAUDE.md "Architecture". Do not shard.
      const id = env.RELAY.idFromName("relay");
      const stub = env.RELAY.get(id);
      return stub.fetch(request);
    }

    // The static admin page lands in chunk 4.
    return new Response("bothy: admin page not yet implemented", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  },
} satisfies ExportedHandler<Env>;
