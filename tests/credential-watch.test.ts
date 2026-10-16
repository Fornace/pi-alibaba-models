import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  changedCredentials,
  createCredentialWatch,
  credentialSignature,
  type CredentialSet,
} from "../extensions/credential-watch.ts";

// The watch is the only place a mid-session /login becomes visible: pi writes
// the credential and fires no event, so these tests pin what "changed" means —
// including the two ways a naive reading gets it wrong (a first look is not a
// change, and a failed reaction must not be forgotten).

describe("credentialSignature", () => {
  it("is stable, key-specific, and leaks nothing", () => {
    const key = "sk-abcdef1234567890";
    assert.equal(credentialSignature(key), credentialSignature(key));
    assert.notEqual(credentialSignature(key), credentialSignature("sk-other-000"));
    assert.match(credentialSignature(key), /^[0-9a-f]{16}$/);
    assert.ok(!credentialSignature(key).includes("abcdef"));
    assert.ok(!key.includes(credentialSignature(key)));
  });

  it("signs an absent credential as null, which is a state of its own", () => {
    assert.equal(credentialSignature(null), null);
    assert.equal(credentialSignature(undefined), null);
    // An empty key is no credential — the same reading `readCloudKey` and
    // `extractKey` give it, so a watch cannot mistake "" for a logged-in state.
    assert.equal(credentialSignature(""), null);
  });
});

describe("changedCredentials", () => {
  it("reports a swap, a login, and a logout alike", () => {
    assert.deepEqual(changedCredentials({ cloud: "a" }, { cloud: "b" }), ["cloud"]);
    assert.deepEqual(changedCredentials({ cloud: null }, { cloud: "b" }), ["cloud"]);
    assert.deepEqual(changedCredentials({ cloud: "a" }, { cloud: null }), ["cloud"]);
    assert.deepEqual(changedCredentials({}, { cloud: "b" }), ["cloud"]);
    assert.deepEqual(changedCredentials({ cloud: "a" }, {}), ["cloud"]);
  });

  it("names every credential that moved, sorted, and nothing else", () => {
    const before = { cloud: "a", plan: "p" };
    assert.deepEqual(changedCredentials(before, { cloud: "a", plan: "p" }), []);
    assert.deepEqual(changedCredentials(before, { cloud: "b", plan: "q" }), ["cloud", "plan"]);
    assert.deepEqual(changedCredentials(before, { plan: "q", cloud: "b" }), ["cloud", "plan"]);
  });
});

describe("createCredentialWatch", () => {
  /** A watch over a set the test moves by hand. */
  function harness(initial: CredentialSet) {
    let current = { ...initial };
    const fired: { changed: string[]; current: CredentialSet }[] = [];
    let failNext = 0;
    let throwOnRead = 0;
    const watch = createCredentialWatch({
      read: () => {
        if (throwOnRead > 0) { throwOnRead--; throw new Error("auth.json is mid-write"); }
        return { ...current };
      },
      onChange: async (changed, set) => {
        if (failNext > 0) { failNext--; throw new Error("the endpoint probe failed"); }
        fired.push({ changed, current: set });
      },
    });
    return {
      watch,
      fired,
      set: (next: CredentialSet) => { current = { ...current, ...next }; },
      failNext: (n = 1) => { failNext = n; },
      throwOnRead: (n = 1) => { throwOnRead = n; },
    };
  }

  it("baselines at creation, so the first check reports nothing", async () => {
    const h = harness({ cloud: "a" });
    assert.deepEqual(await h.watch.check(), []);
    assert.deepEqual(h.fired, []);
  });

  it("reports a credential written after the baseline — the /login before the first turn", async () => {
    const h = harness({ cloud: "a" });
    h.set({ cloud: "b" });
    assert.deepEqual(await h.watch.check(), ["cloud"]);
    assert.deepEqual(h.fired.length, 1);
    assert.deepEqual(h.fired[0].changed, ["cloud"]);
    assert.deepEqual(h.fired[0].current, { cloud: "b" });
    // …and once only: the baseline moved with it.
    assert.deepEqual(await h.watch.check(), []);
    assert.deepEqual(h.fired.length, 1);
  });

  it("reports a logout, and a login back", async () => {
    const h = harness({ cloud: "a", plan: null });
    h.set({ cloud: null });
    assert.deepEqual(await h.watch.check(), ["cloud"]);
    h.set({ cloud: "a", plan: "p" });
    assert.deepEqual(await h.watch.check(), ["cloud", "plan"]);
    assert.equal(h.fired.length, 2);
  });

  it("leaves the baseline alone when the reaction throws, so the next check retries", async () => {
    const h = harness({ cloud: "a" });
    h.set({ cloud: "b" });
    h.failNext();
    assert.deepEqual(await h.watch.check(), ["cloud"], "the failed change is still reported");
    assert.deepEqual(h.fired, []);
    assert.deepEqual(await h.watch.check(), ["cloud"], "and reported again");
    assert.deepEqual(h.fired.length, 1, "until the reaction gets through");
    assert.deepEqual(await h.watch.check(), []);
  });

  it("ignores a read that throws instead of mistaking it for a change", async () => {
    const h = harness({ cloud: "a" });
    h.throwOnRead();
    assert.deepEqual(await h.watch.check(), []);
    assert.deepEqual(h.fired, []);
    // The baseline survived the unreadable moment, so a real swap is still seen.
    h.set({ cloud: "b" });
    assert.deepEqual(await h.watch.check(), ["cloud"]);
  });

  it("serializes concurrent checks into one reaction", async () => {
    const h = harness({ cloud: "a" });
    h.set({ cloud: "b" });
    const [first, second] = await Promise.all([h.watch.check(), h.watch.check()]);
    assert.deepEqual(first, ["cloud"]);
    assert.deepEqual(second, []);
    assert.deepEqual(h.fired.length, 1);
  });

  it("rebase() adopts what is there without firing", async () => {
    const h = harness({ cloud: "a" });
    h.set({ cloud: "b" });
    h.watch.rebase();
    assert.deepEqual(await h.watch.check(), []);
    assert.deepEqual(h.fired, []);
    // …and stays a watch afterwards.
    h.set({ cloud: "c" });
    assert.deepEqual(await h.watch.check(), ["cloud"]);
    assert.deepEqual(h.fired.length, 1);
  });
});
