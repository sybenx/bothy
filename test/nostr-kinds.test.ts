// Unit coverage for NIP-01 "Kinds" boundary classification (nips/01.md):
//   regular      1000 <= n < 10000 || 4 <= n < 45 || n == 1 || n == 2
//   replaceable  10000 <= n < 20000 || n == 0 || n == 3
//   ephemeral    20000 <= n < 30000
//   addressable  30000 <= n < 40000
// 45-999 and n >= 40000 are undefined by the spec. Pure-function test
// against the classifiers directly (no DO/socket round trip needed) so
// every boundary can be asserted precisely and cheaply.
import { describe, expect, it } from "vitest";
import { isAddressableKind, isEphemeralKind, isReplaceableKind } from "../src/nostr";

const cases: Array<{
  kind: number;
  replaceable: boolean;
  addressable: boolean;
  ephemeral: boolean;
}> = [
  { kind: 0, replaceable: true, addressable: false, ephemeral: false },
  { kind: 1, replaceable: false, addressable: false, ephemeral: false },
  { kind: 2, replaceable: false, addressable: false, ephemeral: false },
  { kind: 3, replaceable: true, addressable: false, ephemeral: false },
  { kind: 4, replaceable: false, addressable: false, ephemeral: false },
  { kind: 44, replaceable: false, addressable: false, ephemeral: false },
  { kind: 45, replaceable: false, addressable: false, ephemeral: false }, // undefined range
  { kind: 999, replaceable: false, addressable: false, ephemeral: false }, // undefined range
  { kind: 1000, replaceable: false, addressable: false, ephemeral: false },
  { kind: 9999, replaceable: false, addressable: false, ephemeral: false },
  { kind: 10000, replaceable: true, addressable: false, ephemeral: false },
  { kind: 19999, replaceable: true, addressable: false, ephemeral: false },
  { kind: 20000, replaceable: false, addressable: false, ephemeral: true },
  { kind: 29999, replaceable: false, addressable: false, ephemeral: true },
  { kind: 30000, replaceable: false, addressable: true, ephemeral: false },
  { kind: 39999, replaceable: false, addressable: true, ephemeral: false },
  { kind: 40000, replaceable: false, addressable: false, ephemeral: false }, // undefined range
];

describe("NIP-01 kind classification boundaries", () => {
  for (const c of cases) {
    it(`kind ${c.kind}: replaceable=${c.replaceable} addressable=${c.addressable} ephemeral=${c.ephemeral}`, () => {
      expect(isReplaceableKind(c.kind)).toBe(c.replaceable);
      expect(isAddressableKind(c.kind)).toBe(c.addressable);
      expect(isEphemeralKind(c.kind)).toBe(c.ephemeral);
    });
  }

  it("exactly one classifier (or none, for regular/undefined kinds) is true per kind", () => {
    for (const c of cases) {
      const trueCount = [c.replaceable, c.addressable, c.ephemeral].filter(Boolean).length;
      expect(trueCount).toBeLessThanOrEqual(1);
    }
  });
});
