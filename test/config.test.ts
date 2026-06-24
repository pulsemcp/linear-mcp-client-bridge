import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

const TOUCHED = [
  "ANTHROPIC_API_KEY",
  "LINEAR_API_TOKEN",
  "LINEAR_API_URL",
  "AGENT_MODEL",
  "AGENT_PERMISSION_MODE",
  "AGENT_ALLOWED_TOOLS",
  "AGENT_DISALLOWED_TOOLS",
  "POLL_INTERVAL_SECONDS",
  "LINEAR_TEAM_KEYS",
  "STATE_DIR",
  "PROJECT_ROOT",
  "VIZ_ENABLED",
  "VIZ_PORT",
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

test("throws when LINEAR_API_TOKEN is missing", () => {
  withEnv({ ANTHROPIC_API_KEY: "sk-ant" }, () => {
    assert.throws(() => loadConfig(), /LINEAR_API_TOKEN/);
  });
});

test("ANTHROPIC_API_KEY is optional (falls back to the CLI's own login)", () => {
  withEnv({ LINEAR_API_TOKEN: "lin_api_x" }, () => {
    const c = loadConfig();
    assert.equal(c.anthropicApiKey, undefined);
    assert.equal(c.linearApiToken, "lin_api_x");
  });
  // A blank value is treated the same as unset.
  withEnv({ LINEAR_API_TOKEN: "lin_api_x", ANTHROPIC_API_KEY: "   " }, () => {
    assert.equal(loadConfig().anthropicApiKey, undefined);
  });
});

test("captures ANTHROPIC_API_KEY when set", () => {
  withEnv({ ANTHROPIC_API_KEY: "sk-ant-123", LINEAR_API_TOKEN: "lin_api_x" }, () => {
    assert.equal(loadConfig().anthropicApiKey, "sk-ant-123");
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
    // The activity view is on by default, on port 8787.
    assert.equal(c.vizEnabled, true);
    assert.equal(c.vizPort, 8787);
  });
});

test("activity view can be disabled and re-ported", () => {
  withEnv(
    { LINEAR_API_TOKEN: "lin_api_x", VIZ_ENABLED: "false", VIZ_PORT: "9000" },
    () => {
      const c = loadConfig();
      assert.equal(c.vizEnabled, false);
      assert.equal(c.vizPort, 9000);
    },
  );
  // Any non-"false" value keeps it enabled.
  withEnv({ LINEAR_API_TOKEN: "lin_api_x", VIZ_ENABLED: "FALSE" }, () => {
    assert.equal(loadConfig().vizEnabled, false); // case-insensitive
  });
  withEnv({ LINEAR_API_TOKEN: "lin_api_x", VIZ_ENABLED: "yes" }, () => {
    assert.equal(loadConfig().vizEnabled, true);
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
