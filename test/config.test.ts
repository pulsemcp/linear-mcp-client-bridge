import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

const REQUIRED = ["ANTHROPIC_API_KEY", "LINEAR_API_TOKEN"];
const TOUCHED = [
  ...REQUIRED,
  "LINEAR_API_URL",
  "AGENT_MODEL",
  "AGENT_PERMISSION_MODE",
  "AGENT_ALLOWED_TOOLS",
  "AGENT_DISALLOWED_TOOLS",
  "POLL_INTERVAL_SECONDS",
  "LINEAR_TEAM_KEYS",
  "STATE_DIR",
  "PROJECT_ROOT",
];

/** Run `fn` with a clean, controlled slice of the environment. */
function withEnv(env: Record<string, string>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of TOUCHED) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    for (const key of TOUCHED) {
      const prev = saved.get(key);
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }
}

test("throws when a required secret is missing", () => {
  withEnv({ LINEAR_API_TOKEN: "lin_api_x" }, () => {
    assert.throws(() => loadConfig(), /ANTHROPIC_API_KEY/);
  });
});

test("applies sensible defaults", () => {
  withEnv({ ANTHROPIC_API_KEY: "sk-ant", LINEAR_API_TOKEN: "lin_api_x" }, () => {
    const c = loadConfig();
    assert.equal(c.model, "claude-opus-4-8");
    assert.equal(c.permissionMode, "bypassPermissions");
    assert.equal(c.pollIntervalSeconds, 20);
    assert.equal(c.linearApiUrl, "https://api.linear.app/graphql");
    assert.deepEqual(c.teamKeys, []);
    assert.deepEqual(c.allowedTools, []);
    assert.deepEqual(c.disallowedTools, []);
  });
});

test("rejects an unknown permission mode", () => {
  withEnv(
    { ANTHROPIC_API_KEY: "sk-ant", LINEAR_API_TOKEN: "lin_api_x", AGENT_PERMISSION_MODE: "yolo" },
    () => {
      assert.throws(() => loadConfig(), /AGENT_PERMISSION_MODE/);
    },
  );
});

test("parses overrides, uppercases team keys, splits tool lists", () => {
  withEnv(
    {
      ANTHROPIC_API_KEY: "sk-ant",
      LINEAR_API_TOKEN: "lin_api_x",
      AGENT_MODEL: "claude-sonnet-4-6",
      POLL_INTERVAL_SECONDS: "5",
      LINEAR_TEAM_KEYS: "eng, ops ,, qa",
      AGENT_DISALLOWED_TOOLS: "Bash, Write ,Edit",
      AGENT_ALLOWED_TOOLS: "mcp__linear__*",
    },
    () => {
      const c = loadConfig();
      assert.equal(c.model, "claude-sonnet-4-6");
      assert.equal(c.pollIntervalSeconds, 5);
      assert.deepEqual(c.teamKeys, ["ENG", "OPS", "QA"]);
      assert.deepEqual(c.disallowedTools, ["Bash", "Write", "Edit"]);
      assert.deepEqual(c.allowedTools, ["mcp__linear__*"]);
    },
  );
});
