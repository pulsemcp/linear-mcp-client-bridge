import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildChildEnv,
  buildClaudeArgs,
  normalizeStreamObject,
  parseClaudeResult,
  preview,
  StreamParser,
  type AgentStreamEvent,
} from "../src/session.js";

const base = {
  model: "claude-opus-4-8",
  permissionMode: "bypassPermissions",
  allowedTools: [] as string[],
  disallowedTools: [] as string[],
  mcpConfigs: [] as string[],
};

test("buildClaudeArgs sets print mode, streaming json output, model and permission mode", () => {
  const args = buildClaudeArgs(base);
  assert.ok(args.includes("--print"));
  // Streaming NDJSON so we see each message/tool call live; --verbose is
  // required for streaming in print mode.
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(args.includes("--verbose"));
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

test("buildChildEnv pins ANTHROPIC_API_KEY when a key is configured", () => {
  const env = buildChildEnv({ PATH: "/bin" }, "sk-ant-123");
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-123");
  assert.equal(env.PATH, "/bin");
});

test("buildChildEnv overrides an inherited key with the configured one", () => {
  const env = buildChildEnv({ ANTHROPIC_API_KEY: "inherited" }, "sk-ant-pinned");
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-pinned");
});

test("buildChildEnv leaves an inherited key in place when none is configured", () => {
  // Lets an ambient ANTHROPIC_API_KEY (or a `claude login`) keep working.
  const env = buildChildEnv({ ANTHROPIC_API_KEY: "inherited" }, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, "inherited");
});

test("buildChildEnv strips a blank inherited key so it can't shadow the CLI login", () => {
  const env = buildChildEnv({ ANTHROPIC_API_KEY: "   " }, undefined);
  assert.ok(!("ANTHROPIC_API_KEY" in env));
});

test("preview collapses whitespace and truncates with an ellipsis", () => {
  assert.equal(preview("  hello   world \n there "), "hello world there");
  assert.equal(preview("abcdef", 4), "abc…");
  // Exactly at the limit is left intact.
  assert.equal(preview("abcd", 4), "abcd");
});

test("normalizeStreamObject maps a system/init line to an init event", () => {
  const events = normalizeStreamObject(
    {
      type: "system",
      subtype: "init",
      session_id: "s1",
      tools: ["Read", "Bash", "mcp__linear__get_issue"],
      mcp_servers: [{ name: "linear" }, { name: "gateway" }, { notName: "x" }],
    },
    "{}",
  );
  assert.deepEqual(events, [
    { kind: "init", tools: 3, mcpServers: ["linear", "gateway"], sessionId: "s1" },
  ]);
});

test("normalizeStreamObject splits an assistant message into text + tool_use events", () => {
  const events = normalizeStreamObject(
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Looking into it." },
          { type: "text", text: "   " }, // blank text is dropped
          { type: "tool_use", id: "t1", name: "mcp__linear__get_issue", input: { id: "ENG-1" } },
        ],
      },
    },
    "{}",
  );
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { kind: "assistant", text: "Looking into it." });
  assert.equal(events[1]?.kind, "tool-use");
  assert.equal((events[1] as { tool: string }).tool, "mcp__linear__get_issue");
  assert.equal((events[1] as { input: string }).input, '{"id":"ENG-1"}');
  assert.equal((events[1] as { toolUseId?: string }).toolUseId, "t1");
});

test("normalizeStreamObject maps a user tool_result (string and error) to tool-result events", () => {
  const ok = normalizeStreamObject(
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ENG-1 ok" }] } },
    "{}",
  );
  assert.deepEqual(ok, [{ kind: "tool-result", text: "ENG-1 ok", isError: false, toolUseId: "t1" }]);

  const err = normalizeStreamObject(
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: [{ type: "text", text: "boom" }] }] },
    },
    "{}",
  );
  assert.deepEqual(err, [{ kind: "tool-result", text: "boom", isError: true, toolUseId: "t2" }]);
});

test("normalizeStreamObject parses the terminal result line; unknown types yield nothing", () => {
  const result = normalizeStreamObject(
    { type: "result" },
    JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: "s9", is_error: false }),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]?.kind, "result");
  assert.equal((result[0] as { result: { text: string } }).result.text, "done");
  assert.deepEqual(normalizeStreamObject({ type: "something-else" }, "{}"), []);
  assert.deepEqual(normalizeStreamObject(null, "{}"), []);
});

test("StreamParser streams events live, labels tool results, and exposes the final result", () => {
  const seen: AgentStreamEvent[] = [];
  const parser = new StreamParser((e) => seen.push(e));

  // Feed the NDJSON in arbitrary chunks to prove line-buffering across writes.
  parser.push('{"type":"system","subtype":"init","session_id":"s1","tools":["Read"],"mcp_servers":[{"name":"linear"}]}\n');
  parser.push('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","na');
  parser.push('me":"mcp__linear__get_issue","input":{"id":"ENG-1"}}]}}\n');
  parser.push('not json — should be ignored\n');
  parser.push('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"found it"}]}}\n');
  // Terminal result without a trailing newline — flushed by end().
  parser.push('{"type":"result","subtype":"success","result":"all done","session_id":"s1","is_error":false}');
  parser.end();

  const kinds = seen.map((e) => e.kind);
  assert.deepEqual(kinds, ["init", "tool-use", "tool-result", "result"]);
  assert.equal(parser.toolNameFor("t1"), "mcp__linear__get_issue");
  assert.equal(parser.finalResult?.text, "all done");
  assert.equal(parser.finalResult?.sessionId, "s1");
  assert.equal(parser.finalResult?.isError, false);
});
