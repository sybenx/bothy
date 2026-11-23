// Private profiles (README "Private profiles"): a member's name and photo
// are seen only by their home. Their kind 0 is stored here as usual, and
// served only to a NIP-42 authenticated owner, admin or member of this
// home, in stored reads (relay.ts handleReqInner, through filters.ts
// FilterQueryOptions.hideMemberProfiles) and in live fan-out
// (relay.ts broadcast, through mayReceiveProfile below). The two must
// agree exactly, as the gift wrap gates do.
//
//   reader                     sees members' kind 0   sees removed-in-grace kind 0
//   owner, admin               yes                    yes
//   member                     yes (*)                no
//   anyone else, or no AUTH    no                     no
//
//   (*) with MEMBER_LIST=hidden, only on a filter that names `authors`,
//       so a plain member cannot list the home by asking for every kind 0.
//
// Always visible to everyone: the owner's own kind 0 (his main key is a
// public identity), anyone's own kind 0 to themselves, and the kind 0 of
// people who are not and were not members here.
//
// Withheld by OMISSION, never refusal: a stranger asking for a member's
// profile gets EOSE, the same answer as for a key with nothing stored, so
// the read cannot be used to test membership.
import type { FilterQueryOptions } from "./filters";
import { PROFILE_KIND } from "./filters";
import { memberListVisibility } from "./limits";
import type { Filter, NostrEvent } from "./nostr";
import { isFormerMember, isMember, roleOf } from "./storage";

export type ProfileGate = FilterQueryOptions["hideMemberProfiles"];

// The read gate for one connection, resolved once per REQ. `undefined`
// means unrestricted (the owner or an admin). Unauthenticated callers pay
// no storage read here.
export function profileGateFor(
  sql: SqlStorage,
  env: Env,
  authed: string | undefined,
  owner: string | null,
): ProfileGate {
  const base = { owner: owner ?? "", self: authed ?? "" };
  if (authed === undefined) return { hide: "all", ...base, requireAuthors: false };
  const role = roleOf(sql, authed, owner);
  if (role === "owner" || role === "admin") return undefined;
  if (role === "member") {
    return { hide: "former", ...base, requireAuthors: memberListVisibility(env) === "hidden" };
  }
  return { hide: "all", ...base, requireAuthors: false };
}

// Whether a freshly stored event is a gated profile at all: a kind 0 from
// a current or removed-in-grace member who is not the owner. Answered once
// per broadcast, so ungated events pay nothing and a member's kind 0 pays
// two PK seeks.
export type ProfileAuthor = "member" | "former" | null;

export function gatedProfileAuthor(sql: SqlStorage, event: NostrEvent, owner: string | null): ProfileAuthor {
  if (event.kind !== PROFILE_KIND) return null;
  if (owner !== null && event.pubkey === owner) return null;
  if (isMember(sql, event.pubkey)) return "member";
  if (isFormerMember(sql, event.pubkey)) return "former";
  return null;
}

// The filters of one subscription that may carry this gated profile to a
// reader holding `gate`, mirroring buildFilterQuery's condition. The
// caller still runs matchesAnyFilter on what this returns.
export function filtersAllowedForProfile(
  gate: ProfileGate,
  author: Exclude<ProfileAuthor, null>,
  event: NostrEvent,
  filters: Filter[],
): Filter[] {
  if (gate === undefined) return filters;
  if (event.pubkey === gate.self) return filters;
  return filters.filter((f) => {
    const hide = gate.requireAuthors && f.authors === undefined ? "all" : gate.hide;
    if (hide === "all") return false;
    // "former": only removed-in-grace profiles are hidden.
    return author === "member";
  });
}
