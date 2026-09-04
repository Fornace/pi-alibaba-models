import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseWorkspaceCloudDomain,
  parseWorkspaceIdFromLimits,
  REGION_SHARED_DOMAINS,
  regionForSharedCloudDomain,
  sanitizeWorkspaceId,
  shouldAutoUpgradeWorkspace,
  WORKSPACE_PROBE_RETRY_MS,
} from "../extensions/alibaba.ts";

describe("regionForSharedCloudDomain", () => {
  it("maps the three shared regional domains to their workspace regions", () => {
    assert.equal(regionForSharedCloudDomain("dashscope.aliyuncs.com"), "cn-beijing");
    assert.equal(regionForSharedCloudDomain("dashscope-intl.aliyuncs.com"), "ap-southeast-1");
    assert.equal(regionForSharedCloudDomain("dashscope-us.aliyuncs.com"), "us-east-1");
    assert.equal(regionForSharedCloudDomain(" DashScope.aliyuncs.com "), "cn-beijing");
  });

  it("never fires for Hong Kong, custom, or workspace domains", () => {
    assert.equal(regionForSharedCloudDomain("cn-hongkong.dashscope.aliyuncs.com"), null);
    assert.equal(regionForSharedCloudDomain("llm-abc123.cn-beijing.maas.aliyuncs.com"), null);
    assert.equal(regionForSharedCloudDomain("proxy.example.com"), null);
    assert.equal(regionForSharedCloudDomain(""), null);
  });
});

describe("sanitizeWorkspaceId", () => {
  it("accepts realistic ids and normalizes them", () => {
    assert.equal(sanitizeWorkspaceId("llm-n9h5iz3a78nfmn7k"), "llm-n9h5iz3a78nfmn7k");
    assert.equal(sanitizeWorkspaceId(" LLM-ABC123 "), "llm-abc123");
  });

  it("rejects anything that could poison a hostname", () => {
    assert.equal(sanitizeWorkspaceId("evil.example.com/x"), null);
    assert.equal(sanitizeWorkspaceId("ws id"), null);
    assert.equal(sanitizeWorkspaceId("-leading-dash"), null);
    assert.equal(sanitizeWorkspaceId("ab"), null);
    assert.equal(sanitizeWorkspaceId(""), null);
    assert.equal(sanitizeWorkspaceId(undefined), null);
    assert.equal(sanitizeWorkspaceId(42), null);
  });
});

describe("parseWorkspaceCloudDomain", () => {
  it("recognizes workspace domains in every workspace region", () => {
    assert.deepEqual(parseWorkspaceCloudDomain("llm-abc123.cn-beijing.maas.aliyuncs.com"), { wsid: "llm-abc123", region: "cn-beijing" });
    assert.deepEqual(parseWorkspaceCloudDomain("LLM-ABC123.ap-southeast-1.maas.aliyuncs.com"), { wsid: "llm-abc123", region: "ap-southeast-1" });
    assert.ok(parseWorkspaceCloudDomain("llm-abc123.ap-northeast-1.maas.aliyuncs.com"));
    assert.ok(parseWorkspaceCloudDomain("llm-abc123.eu-central-1.maas.aliyuncs.com"));
    assert.ok(parseWorkspaceCloudDomain("llm-abc123.us-east-1.maas.aliyuncs.com"));
  });

  it("rejects shared, unknown-region, and malformed hosts", () => {
    assert.equal(parseWorkspaceCloudDomain("dashscope.aliyuncs.com"), null);
    assert.equal(parseWorkspaceCloudDomain("dashscope-intl.aliyuncs.com"), null);
    assert.equal(parseWorkspaceCloudDomain("llm-abc123.mars-1.maas.aliyuncs.com"), null);
    assert.equal(parseWorkspaceCloudDomain("foo.bar.maas.aliyuncs.com"), null);
    assert.equal(parseWorkspaceCloudDomain("maas.aliyuncs.com"), null);
    assert.equal(parseWorkspaceCloudDomain(""), null);
  });
});

describe("REGION_SHARED_DOMAINS", () => {
  it("inverts the shared-domain map for the regions that have one", () => {
    assert.equal(REGION_SHARED_DOMAINS["cn-beijing"], "dashscope.aliyuncs.com");
    assert.equal(REGION_SHARED_DOMAINS["ap-southeast-1"], "dashscope-intl.aliyuncs.com");
    assert.equal(REGION_SHARED_DOMAINS["us-east-1"], "dashscope-us.aliyuncs.com");
    assert.equal(regionForSharedCloudDomain(REGION_SHARED_DOMAINS["cn-beijing"]), "cn-beijing");
  });

  it("has no entry for the workspace-only regions", () => {
    assert.equal(REGION_SHARED_DOMAINS["ap-northeast-1"], undefined);
    assert.equal(REGION_SHARED_DOMAINS["eu-central-1"], undefined);
  });
});

describe("parseWorkspaceIdFromLimits", () => {
  it("takes the first usable workspace_id", () => {
    const json = {
      output: {
        quotas: [
          { model: "a", workspace_id: null },
          { model: "b", workspace_id: "llm-one1" },
          { model: "c", workspace_id: "llm-two2" },
        ],
      },
    };
    assert.equal(parseWorkspaceIdFromLimits(json), "llm-one1");
  });

  it("returns null on junk shapes", () => {
    assert.equal(parseWorkspaceIdFromLimits({}), null);
    assert.equal(parseWorkspaceIdFromLimits({ output: {} }), null);
    assert.equal(parseWorkspaceIdFromLimits({ output: { quotas: [] } }), null);
    assert.equal(parseWorkspaceIdFromLimits({ output: { quotas: [{ workspace_id: "!!" }] } }), null);
    assert.equal(parseWorkspaceIdFromLimits({ output: { quotas: [null] } }), null);
    assert.equal(parseWorkspaceIdFromLimits(null), null);
  });
});

describe("shouldAutoUpgradeWorkspace", () => {
  const now = 1_800_000_000_000;

  it("fires by default on a shared domain", () => {
    assert.equal(shouldAutoUpgradeWorkspace({}, "dashscope.aliyuncs.com", now), true);
    assert.equal(shouldAutoUpgradeWorkspace({ cloudAutoWorkspaceDomain: true }, "dashscope-intl.aliyuncs.com", now), true);
    assert.equal(shouldAutoUpgradeWorkspace({}, "dashscope-us.aliyuncs.com", now), true);
  });

  it("respects the explicit opt-out", () => {
    assert.equal(shouldAutoUpgradeWorkspace({ cloudAutoWorkspaceDomain: false }, "dashscope.aliyuncs.com", now), false);
  });

  it("does not fire off the shared domains", () => {
    assert.equal(shouldAutoUpgradeWorkspace({}, "llm-x1ab.cn-beijing.maas.aliyuncs.com", now), false);
    assert.equal(shouldAutoUpgradeWorkspace({}, "cn-hongkong.dashscope.aliyuncs.com", now), false);
    assert.equal(shouldAutoUpgradeWorkspace({}, "custom.example.com", now), false);
  });

  it("backs off for 24h after a failed probe", () => {
    const fresh = now - WORKSPACE_PROBE_RETRY_MS + 60_000;
    assert.equal(shouldAutoUpgradeWorkspace({ cloudWorkspaceProbeFailedAt: fresh }, "dashscope.aliyuncs.com", now), false);
    const stale = now - WORKSPACE_PROBE_RETRY_MS - 1;
    assert.equal(shouldAutoUpgradeWorkspace({ cloudWorkspaceProbeFailedAt: stale }, "dashscope.aliyuncs.com", now), true);
    assert.equal(shouldAutoUpgradeWorkspace({ cloudWorkspaceProbeFailedAt: NaN }, "dashscope.aliyuncs.com", now), true);
  });
});
