// Best-effort kind-0 profile lookup for the claim confirm step (CLAUDE.md
// "Claim implementation": "Resolve and display the profile before
// confirming... a courtesy against typos, not a security control... If
// the lookup fails, allow the claim anyway; never block on it."). Runs
// in the Worker (src/index.ts), not the Durable Object -- a short-lived
// outbound WebSocket from the DO would pin it in memory for up to 15
// minutes (CLAUDE.md "The budget"); the stateless Worker has no such
// cost.
const WELL_KNOWN_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];
const LOOKUP_TIMEOUT_MS = 2500;

export interface Profile {
  name?: string;
  picture?: string;
}

function queryOne(relayUrl: string, pubkey: string): Promise<Profile | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: Profile | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closing/closed
      }
      resolve(result);
    };

    let socket: WebSocket;
    try {
      socket = new WebSocket(relayUrl);
    } catch {
      resolve(null);
      return;
    }

    const timer = setTimeout(() => done(null), LOOKUP_TIMEOUT_MS);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(["REQ", "profile", { kinds: [0], authors: [pubkey], limit: 1 }]));
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      try {
        const frame = JSON.parse(event.data) as unknown[];
        if (frame[0] === "EVENT" && frame[1] === "profile") {
          const content = JSON.parse((frame[2] as { content: string }).content) as Record<string, unknown>;
          const profile: Profile = {};
          if (typeof content.name === "string") profile.name = content.name;
          if (typeof content.picture === "string") profile.picture = content.picture;
          done(profile);
        } else if (frame[0] === "EOSE") {
          done(null);
        }
      } catch {
        // malformed frame from a remote relay -- ignore, let the timeout resolve
      }
    });
    socket.addEventListener("error", () => done(null));
    socket.addEventListener("close", () => done(null));
  });
}

export async function lookupProfile(pubkey: string): Promise<Profile | null> {
  const results = await Promise.all(WELL_KNOWN_RELAYS.map((url) => queryOne(url, pubkey)));
  return results.find((r) => r !== null) ?? null;
}
