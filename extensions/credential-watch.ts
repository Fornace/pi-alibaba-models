// The credential change pi never announces.
//
// pi writes credentials from its own /login dialog and fires no extension event
// for it. What a write does trigger is a recomposition plus a refresh with
// `allowNetwork: false` (verified in 1.2.0 and 1.3.0:
// `ModelRuntime.synchronizeCredentialState`), and that refresh asks our
// `refreshModels` for cards — which are built from the config as it stands. So
// a key swapped mid-session leaves everything this extension derived from the
// previous key in place, and nothing re-derives it until the next
// `session_start`:
//
//   • the Cloud domain, which the key binding derives per key: a workspace
//     domain belongs to one business space, and a new key is usually not in it,
//     so every request after the swap is answered by an endpoint that rejects
//     it;
//   • the catalog, which the account's own authorization filters;
//   • the warm template, which carries the resolved `Authorization` header of
//     the request it captured and replays it verbatim — the one place where the
//     *old* key keeps being sent after the swap.
//
// This module is the observation point. `check()` compares the effective
// credentials with the ones last seen and reports which names moved; what a
// change means is entirely the caller's business. Detection is pull, not push:
// there is no credential event to subscribe to, and auth.json can be written by
// pi (in place), by this extension (atomic rename) or by another pi instance
// while this one idles. Callers check where being late costs something: this
// extension does it before every turn and before every compaction, the two
// points where a Cloud request is about to be dispatched. pi's own warmer (mode
// `pi`) is the one Cloud request with no check ahead of it — it resolves auth
// itself, so a stale endpoint only fails its warm, which ends its run.
//
// Credentials travel as signatures only (sha256, 16 hex chars, the same shape
// as the `cloudKeyFingerprint` binding field): enough to tell two keys apart,
// never enough to use one, so a log line or a status readout cannot leak it.

import { createHash } from "node:crypto";

/**
 * Opaque signature of a credential — which key it is, never what it says.
 * `null` in, `null` out: an absent credential is a state of its own, and a
 * logout has to be as visible to a watcher as a swap.
 */
export function credentialSignature(key: string): string;
export function credentialSignature(key: string | null | undefined): string | null;
export function credentialSignature(key: string | null | undefined): string | null {
  return key ? createHash("sha256").update(key).digest("hex").slice(0, 16) : null;
}

/** Signature per credential name. `null` means "not logged in". */
export type CredentialSet = Record<string, string | null>;

export interface CredentialWatchDeps {
  /** The effective credentials right now. Called on every check, so keep it cheap. */
  read(): CredentialSet;
  /**
   * What a change means, with the names that moved (sorted). Awaited, so a
   * caller may re-derive before the request that would otherwise go out stale.
   */
  onChange(changed: string[], current: CredentialSet): void | Promise<void>;
}

export interface CredentialWatch {
  /** Compare with the last seen set and fire `onChange` when something moved. */
  check(): Promise<string[]>;
  /** Adopt the current credentials as the baseline without firing. */
  rebase(): void;
}

/**
 * The effective credentials, or the fallback when reading them fails. A read
 * that throws — a torn auth.json mid-write, a permission error — is not a
 * change: the baseline stays and the next check looks again, so one unreadable
 * moment can neither fire a reaction nor lose one.
 */
function readOr(deps: CredentialWatchDeps, fallback: CredentialSet): CredentialSet {
  try {
    const set = deps.read();
    return set && typeof set === "object" ? set : fallback;
  } catch {
    return fallback;
  }
}

/** Names whose signature moved, including a name that appeared or disappeared. */
export function changedCredentials(previous: CredentialSet, current: CredentialSet): string[] {
  const names = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return [...names].filter((n) => (previous[n] ?? null) !== (current[n] ?? null)).sort();
}

/**
 * One watch per process. Checks are serialized, so two hooks firing at once
 * cannot both react to the same swap; the baseline moves before `onChange` is
 * awaited, and rolls back if it throws, so a failed reaction is retried by the
 * next check instead of being forgotten (the caller's own guards decide what a
 * retry costs).
 */
export function createCredentialWatch(deps: CredentialWatchDeps): CredentialWatch {
  // Baseline at creation, not at the first check: boot already handled the key
  // it found, and a first check that reported it would re-derive on every start.
  // It also means a /login *before* the first turn is a change, not a baseline.
  let seen: CredentialSet = readOr(deps, {});
  let tail: Promise<unknown> = Promise.resolve();

  const run = async (): Promise<string[]> => {
    const current = readOr(deps, seen);
    const changed = changedCredentials(seen, current);
    if (!changed.length) return [];
    const previous = seen;
    seen = current;
    try {
      await deps.onChange(changed, current);
    } catch {
      seen = previous; // retry on the next check
    }
    return changed;
  };

  return {
    check() {
      const next = tail.then(run, run);
      tail = next.then(undefined, () => undefined);
      return next;
    },
    rebase() {
      seen = readOr(deps, seen);
    },
  };
}
