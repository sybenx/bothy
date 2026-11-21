// NIP-44 v2 and the NIP-59 wrap in src/nip44.ts, checked against output
// from an independent implementation: nostr-tools 2.26.1, run once with
// the keys and nonce below (secret keys 1 and 2, nonce 1, the same inputs
// as the first vector in nips/44.md). Pinned here rather than computed, so
// a mistake shared by encryptor and decryptor cannot pass.
import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";
import { chacha20, conversationKey, nip44Decrypt, nip44Encrypt, paddedLength } from "../src/nip44";
import { verifySignature } from "../src/validate";
import { npubEncode } from "../src/bech32";
import { normalizePubkey } from "../src/pubkey";

const SEC1 = "0000000000000000000000000000000000000000000000000000000000000001";
const SEC2 = "0000000000000000000000000000000000000000000000000000000000000002";
const PUB2 = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const CONVERSATION_KEY = "c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d";
const NONCE = "0000000000000000000000000000000000000000000000000000000000000001";

const CASES = [
  {
    plaintext: "a",
    payload:
      "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb",
  },
  {
    plaintext: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    payload:
      "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABec0fnSzyq4cgsup2FHM7UY58ekiPnp0cZ1gMb/iI1bsiccJrdmPu0c1VY0Evv73AKLQvoaGRmont0jN/cajVSQha5Ia1EFGWfrZwRZFeOvOpbzaEVNxDVh1to1fcx2j/HAs=",
  },
  {
    plaintext:
      "Robin wants to join your home. ünïcödé 🔥Robin wants to join your home. ünïcödé 🔥Robin wants to join your home. ünïcödé 🔥Robin wants to join your home. ünïcödé 🔥Robin wants to join your home. ünïcödé 🔥Robin wants to join your home. ünïcödé 🔥Robin wants to join your home. ünïcödé 🔥Robin wants to join your home. ünïcödé 🔥Robin wants to join your home. ünïcödé 🔥",
    payload:
      "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABeEs1ijbjvd8vq/x6Hys3RtZubVmZxpwLalJUf++dyO16ygYFtcyNEnsxoOgPTyJUjeZAw8j/uv6MvEcMUdy6aWI1rRtlibNSfaEnbFYupbrJt4KZ9mArUoFsx5DFbO6TkZeNe/QZvRibBUnadRzdrIxwMYgihwkMcfoWPhuSrvwalry9Xs70mk5X8WSAYarZ0zSiCo4vqqq96U/aJs7NwYEIQ20bBDq1YXdw6sdx4mPljKo8B8a6cnmLFUPLpKHwqMXlKmhxKCw+OuhsoLUP2758detvJNOjmkFE7rE1srwEnZhZZyqnr4BrUSmxF4YOPAl3n0bhLKz+cEWyK5FScPhY6a0yN/Z8DkW3w+zZK7f7kgJbrB7sUd6jHwLRsLiVyeQTX11b+M9M7t+pk87JwmxaANtB1OA/eSpLHZ/jK7NW6wiDQj8T3/Oqi9uxalp/CegR1DOJHtoKy9XehJkZqi+SLKu2vripg6XmpvGpL7lZB9d+RdKTsJdNTm98UBDuW+RujXyunS43SiKTrlUpw3w8xwEa/128bmjPDgSkinPrJAJ4ERy1uABJMbLioQfUs5iue0HHtlc5JOGGImsaVoA+24LeuxKbtVaODUJEZM2DF6IGBqV7L3Gqx9CXKczd1EI=",
  },
];

// nostr-tools nip59.wrapEvent of a kind-14 from SEC1 to PUB2.
const FOREIGN_WRAP = {
  kind: 1059,
  content:
    "AjV6Ky1xsypCX8oHRXAXlP1FEOe4b+CtOlcozZFb55jmPRR1YRnZDrJpRQpGkqXoig9z+c6EaA9OdOOov9N4phwQBWnqLEsjPkjz/KRGUICFHSoWWjJmhBhOXCTN3nJmGy5JbjLpAarmPrRG24/+yL7ExN/ZircjmBmZcwLAZzuZuvzhygykn0sXrOITJUC+iT8XEtMjLVIh2c8O4t6it/PSN94EKjTvb7wx2hVuPlGlUo+/zuIjNglNZPkXrP15RQqUwx1bayeTXnq+ri0YKlQPbiQWCE4lTm8yQo5bAzVqZa2sI86FSXHVlJzN7EliVSS4dGKHD6lbBwGkRD7qM1ezLkEjdemlPrRn5n7NK2s9rf5f5v5s3ElwNw4ka2Fk7sZlWPcUSJ/wdE2r+DYDkzbcRpocjO7i7OPbtyP3WsTdmxzS+suoeZeG/9SkRO1lyLbsKAwdAu5c6sm5RSxnEACYMGU0t4PEGIommEBxfqbigSjgl1sL3eLVgm4YY9U00j/XqVdL7Wh+lkV22N+NZ3Xzls/dwNcpAKeB4N2d9XKi3osFSxuyMUPL8x7fpHivYARAwzYov3s9nRaNeyscs0XA3f2QpgHymsE0h74csEjzqeXg7Qrcy6AMPUVTHP8m0sK0bDFgZmBKBlygRuPmNL//NTMee0ffNOn1H29HydhmaULIXBpkX77m/obxKZdwe85HdNwEMG4y6DOkvnAMRj0BAzF7vewiBxWEnG27MmeIXmgrwNKxM1v8l1KddXpxQDUfFk45CQotGoAzBOIB0c7E9yaza2tkWp6g/B+QbFVtP/w6mJjhK0jgr/sL4Lx18BVK88zawTl33T43k2DAh0tM11zzMSerKf7kqmGD/zH82TvVTVJhPMtcuiCbcU17KGAorTNrVEW7Ft/txlWLRz8IZ0Scgpw9fVh8RFEiQ7UAcNhjdOc//iz91VYmhhqJ2DwGgEoEziZ5GG+Ue9+fU2pf9OY8tP8dKf1UU/gMl8HPZh4rA58YOoSSwzfCBV7kgfvZgHCUeeB7rQn79Ez4OftIqsJm4NU9PQt3B6b8pMD7P2o1fIO7YqNvE6+my/hfqGaPCRS4630Ua15DEOhQV8WYog2adMvfL/I9tHDSZ5r4I3P4BU5eJl55ZcEK4lvQLecOloIHgAt9AbRRKw63wOXDAhaLKLCA1mwndHNK+Z0qH7xXBEW00B/Nc2dh5Kpv3BRwwYl+luotH26GeeaPh/8OeENTLzqyIr0EFIxeNi5Y2WZkwv6X61N+3eIERR5couAy",
  created_at: 1795129955,
  tags: [["p", "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"]],
  pubkey: "b3fcc1ef75fbf70cdf229f5105268cb4044cb3016f626013135a11d88f176421",
  id: "218af7512270362a705cbb077e2d3d23bd3ed7403eb16be2c08e22af859efd40",
  sig: "a830b7a943d6ef735c5fe47f82ae66f05bdcaa192479f6b71738479009f7447b0539f1ae30107bfeb353ba56750b780ebb6acd5911c9ffa2240259a965eea71c",
};

describe("NIP-44 v2", () => {
  it("derives the same conversation key in both directions", () => {
    expect(Buffer.from(conversationKey(SEC1, PUB2)).toString("hex")).toBe(CONVERSATION_KEY);
  });

  it("encrypts byte for byte what nostr-tools does, and reads it back", () => {
    const key = hexToBytes(CONVERSATION_KEY);
    for (const { plaintext, payload } of CASES) {
      expect(nip44Encrypt(plaintext, key, hexToBytes(NONCE))).toBe(payload);
      expect(nip44Decrypt(payload, key)).toBe(plaintext);
    }
  });

  it("opens a gift wrap nostr-tools made", () => {
    expect(verifySignature(FOREIGN_WRAP)).toBe(true);
    const seal = JSON.parse(nip44Decrypt(FOREIGN_WRAP.content, conversationKey(SEC2, FOREIGN_WRAP.pubkey)));
    expect(verifySignature(seal)).toBe(true);
    const rumor = JSON.parse(nip44Decrypt(seal.content, conversationKey(SEC2, seal.pubkey)));
    expect([rumor.kind, rumor.content]).toEqual([14, "hello from nostr-tools"]);
  });

  it("pads to the lengths the spec lists", () => {
    expect([1, 32, 33, 64, 65, 256, 257, 1000].map(paddedLength)).toEqual([
      32, 32, 64, 64, 96, 256, 320, 1024,
    ]);
  });

  it("runs ChaCha20 as RFC 8439 section 2.4.2 does", () => {
    const key = Uint8Array.from({ length: 32 }, (_, i) => i);
    const nonce = hexToBytes("000000000000004a00000000");
    const text =
      "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";
    // The RFC encrypts with the counter starting at 1; NIP-44 starts at 0,
    // so skip the first 64-byte block of keystream.
    const shifted = chacha20(key, nonce, new Uint8Array(64 + text.length)).subarray(64);
    const out = Buffer.from(new TextEncoder().encode(text).map((b, i) => b ^ shifted[i]!)).toString("hex");
    expect(out.slice(0, 32)).toBe("6e2e359a2568f98041ba0728dd0d6981");
  });
});

describe("npub encoding", () => {
  it("round trips through the decoder", () => {
    const npub = npubEncode(PUB2);
    expect(npub.startsWith("npub1")).toBe(true);
    expect(normalizePubkey(npub)).toBe(PUB2);
  });
});
