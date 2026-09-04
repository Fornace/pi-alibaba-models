import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Spec: pi honors PI_CODING_AGENT_DIR as the config directory override
// (docs/environment-variables.md). The extension must read auth.json /
// alibaba-config.json from — and write them to — that directory, never a
// hardcoded ~/.pi/agent. Regression guard for the hardcoded-HOME_DIR bug:
// under an override the extension used to miss /login credentials entirely
// and /alibaba → "Reset all" scrubbed the wrong settings.json.

const EXT_PATH = pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "alibaba.ts")).href;

// Child harness: boots the real extension factory against a fake ExtensionAPI.
// The extension import resolves @earendil-works/pi-coding-agent from the repo's
// node_modules exactly like pi's loader makes it available.
const CHILD = `
import fs from "node:fs";
import path from "node:path";
const dir = process.env.PI_CODING_AGENT_DIR;
const commands = {};
const mod = await import(${JSON.stringify(EXT_PATH)});
await mod.default({
  registerProvider: () => {},
  registerTool: () => {},
  registerCommand: (n, c) => { commands[n] = c; },
  on: () => {},
});
if (process.env.MODE === "boot") {
  process.stdout.write(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
} else if (process.env.MODE === "reset-all") {
  const ctx = {
    modelRegistry: {}, // no authStorage → extension's own auth.json fallback
    reload: async () => {},
    ui: {
      select: async () => "Reset all",
      confirm: async () => true,
      input: async () => "",
      notify: () => {},
    },
  };
  await commands.alibaba.handler("", ctx);
  process.stdout.write(JSON.stringify({
    settings: JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")),
    auth: JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8")),
  }));
}
`;

function runChild(home: string, agentDir: string, mode: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", CHILD],
      { env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, MODE: mode }, timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`child failed: ${err.message}\n${stderr}`));
        else resolve(stdout);
      },
    );
  });
}

function makeFixture(): { home: string; agentDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-alibaba-agentdir-"));
  const home = path.join(root, "home");
  const agentDir = path.join(root, "custom agent dir");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  // Non-routable domain keeps the boot catalog fetch offline and instant.
  fs.writeFileSync(path.join(agentDir, "alibaba-config.json"), JSON.stringify({ cloudDomain: "127.0.0.1:9" }));
  return { home, agentDir };
}

describe("PI_CODING_AGENT_DIR override", () => {
  it("reads auth.json from the override dir (legacy entry migrated in place)", async () => {
    const { home, agentDir } = makeFixture();
    fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
      alibaba: { type: "api_key", key: "sk-fake-cloud-key" },
    }));

    const auth = JSON.parse(await runChild(home, agentDir, "boot"));

    assert.ok(auth["alibaba-cloud"], "cloud credential should be migrated into the override-dir auth.json");
    assert.equal(auth["alibaba-cloud"].key, "sk-fake-cloud-key");
    assert.equal(auth["alibaba"], undefined, "legacy entry should be gone");
    assert.ok(!fs.existsSync(path.join(home, ".pi", "agent")), "must not create a stray ~/.pi/agent under an override");
  });

  it("Reset all scrubs settings.json and auth.json in the override dir", async () => {
    const { home, agentDir } = makeFixture();
    fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
      "alibaba-cloud": { type: "api_key", key: "sk-fake" },
    }));
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
      enabledModels: ["alibaba-cloud/qwen-plus", "other/model"],
      defaultProvider: "alibaba-cloud",
      defaultModel: "qwen-plus",
    }));

    const out = JSON.parse(await runChild(home, agentDir, "reset-all"));

    assert.deepEqual(out.auth, {}, "credentials must be wiped from the override-dir auth.json");
    assert.equal(out.settings.defaultProvider, undefined, "stale defaultProvider must be cleared");
    assert.equal(out.settings.defaultModel, undefined, "stale defaultModel must be cleared");
    assert.deepEqual(out.settings.enabledModels, ["other/model"], "only non-alibaba models may survive");
    assert.ok(!fs.existsSync(path.join(home, ".pi", "agent", "settings.json")), "must not scrub a phantom ~/.pi/agent/settings.json");
  });
});
