import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeArgs, parseClaudeResult } from "../src/session.js";

const base = {
  model: "claude-opus-4-8",
  permissionMode: "bypassPermissions",
  allowedTools: [] as string[],
  disallowedTools: [] as string[],
  mcpConfigs: [] as string[],
};

test("buildClaudeArgs sets print mode, json output, model and permission mode", () => {
  const args = buildClaudeArgs(base);
  assert.ok(args.includes("--print"));
  // --output-format is immediately followed by json.
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  assert.equal(args[args.indexOf("--model") + 1], "claude-opus-4-8");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
});

test("bypassPermissions opts into --dangerously-skip-permissions; other modes do not", () => {
  assert.ok(buildClaudeArgs(base).includes("--dangerously-skip-permissions"));
  assert.ok(
    !buildClaudeArgs({ ...base, permissionMode: "default" }).includes("--dangerously-skip-permissions"),
  );
});

test("tool allow/deny lists are comma-joined and omitted when empty", () => {
  const args = buildClaudeArgs({
    ...base,
    allowedTools: ["mcp__linear__*", "Read"],
    disallowedTools: ["Bash", "Write"],
  });
  assert.equal(args[args.indexOf("--allowedTools") + 1], "mcp__linear__*,Read");
  assert.equal(args[args.indexOf("--disallowedTools") + 1], "Bash,Write");
  // Empty lists produce no flags.
  assert.ok(!buildClaudeArgs(base).includes("--allowedTools"));
  assert.ok(!buildClaudeArgs(base).includes("--disallowedTools"));
});

test("resume is passed only when present", () => {
  assert.ok(!buildClaudeArgs(base).includes("--resume"));
  const args = buildClaudeArgs({ ...base, resume: "sess-1" });
  assert.equal(args[args.indexOf("--resume") + 1], "sess-1");
});

test("mcp configs go through --strict-mcp-config and trail at the end (variadic-safe)", () => {
  const args = buildClaudeArgs({ ...base, mcpConfigs: ['{"mcpServers":{}}', "/app/.mcp.json"] });
  assert.ok(args.includes("--strict-mcp-config"));
  const idx = args.indexOf("--mcp-config");
  assert.deepEqual(args.slice(idx + 1), ['{"mcpServers":{}}', "/app/.mcp.json"]);
  // Nothing follows the variadic values that could be mis-parsed.
  assert.equal(idx + 3, args.length);
});

test("parseClaudeResult extracts text + session id on success", () => {
  const r = parseClaudeResult(
    JSON.stringify({ type: "result", subtype: "success", result: "hello", session_id: "s1", is_error: false }),
  );
  assert.equal(r.text, "hello");
  assert.equal(r.sessionId, "s1");
  assert.equal(r.isError, false);
});

test("parseClaudeResult flags error subtype and is_error", () => {
  assert.equal(parseClaudeResult(JSON.stringify({ subtype: "error_max_turns" })).isError, true);
  assert.equal(parseClaudeResult(JSON.stringify({ subtype: "success", is_error: true })).isError, true);
});

test("parseClaudeResult treats a real auth-failure payload as an error (subtype=success but is_error=true)", () => {
  // Captured verbatim from `claude -p --output-format json` with a bad key:
  // the CLI reports subtype "success" yet sets is_error, so is_error must win.
  const r = parseClaudeResult(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Invalid API key · Fix external API key",
      session_id: "7dcacf80-6421-4761-9ee3-b44db737e646",
    }),
  );
  assert.equal(r.isError, true);
  assert.equal(r.sessionId, "7dcacf80-6421-4761-9ee3-b44db737e646");
  assert.equal(r.text, "Invalid API key · Fix external API key");
});

test("parseClaudeResult throws on empty or non-JSON output", () => {
  assert.throws(() => parseClaudeResult("   "), /no output/);
  assert.throws(() => parseClaudeResult("not json"), /not JSON/);
});
