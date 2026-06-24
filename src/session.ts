import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { StateStore } from "./state.js";
import type { ActivityHub } from "./activity.js";

const require = createRequire(import.meta.url);

// A single turn shouldn't be able to wedge the poll loop forever.
const TURN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Drives Claude through the `claude` CLI in headless print mode (`claude -p`)
 * so that every Linear comment is handled as one more turn in a SINGLE,
 * continuous conversation.
 *
 * The trick is `--resume`: the first turn creates a session and the CLI reports
 * its id in the JSON result; every turn after that passes `--resume <id>`, so
 * the agent keeps the full history of every ticket it has ever seen. That shared
 * memory is the whole point — ticket #42 can be answered with what it learned on
 * ticket #7.
 *
 * We run with `--output-format stream-json` so the CLI emits one JSON object per
 * line *as it works* — the init handshake, each assistant message, every tool
 * call and result, then a final `result` line. We parse that stream live and
 * forward a normalized view of it to the {@link ActivityHub}, which powers the
 * browser activity view. The final `result` line is still the authoritative
 * reply we post back to Linear.
 *
 * The agent's tools come entirely from the operator's `.mcp.json` (an MCP
 * aggregator, or individual servers listed directly — see `.mcp.example.json`).
 * The daemon injects nothing of its own here: its `LINEAR_API_TOKEN` drives only
 * the deterministic poll/post harness, kept deliberately separate from whatever
 * tools the agent is handed.
 */

export interface ClaudeArgsInput {
  model: string;
  permissionMode: string;
  allowedTools: string[];
  disallowedTools: string[];
  /** MCP config entries — each a file path or an inline JSON string. */
  mcpConfigs: string[];
  /** Session id to resume, if we have one. */
  resume?: string;
}

/** Pure construction of the `claude` CLI argv (exported for testing). */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const args = [
    "--print",
    // Stream NDJSON so we see each message/tool call as it happens, not just the
    // final result. `--verbose` is required to stream in print mode.
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    input.model,
    "--permission-mode",
    input.permissionMode,
  ];
  if (input.permissionMode === "bypassPermissions") {
    // bypassPermissions must be explicitly opted into on the CLI.
    args.push("--dangerously-skip-permissions");
  }
  if (input.allowedTools.length) {
    args.push("--allowedTools", input.allowedTools.join(","));
  }
  if (input.disallowedTools.length) {
    args.push("--disallowedTools", input.disallowedTools.join(","));
  }
  if (input.resume) {
    args.push("--resume", input.resume);
  }
  // Strict so ONLY these MCP configs load — deterministic regardless of any
  // ambient Claude config. Variadic, so it must come last.
  if (input.mcpConfigs.length) {
    args.push("--strict-mcp-config", "--mcp-config", ...input.mcpConfigs);
  }
  return args;
}

export interface ClaudeResult {
  text: string;
  sessionId: string | null;
  isError: boolean;
  subtype: string | null;
}

/**
 * Build the child environment for the `claude` CLI.
 *
 * If an API key is configured we pin it. If not, we deliberately leave the
 * inherited env untouched so the CLI can fall back to its own login (a Claude
 * subscription via `claude login`, or an ambient ANTHROPIC_API_KEY) — and we
 * strip a blank ANTHROPIC_API_KEY so an empty value can't shadow that login.
 */
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  apiKey?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (apiKey) {
    env.ANTHROPIC_API_KEY = apiKey;
  } else if (env.ANTHROPIC_API_KEY !== undefined && env.ANTHROPIC_API_KEY.trim() === "") {
    delete env.ANTHROPIC_API_KEY;
  }
  return env;
}

/**
 * Parse the terminal `result` object emitted by `claude --print`.
 *
 * In both `--output-format json` and `--output-format stream-json` the CLI ends
 * with the same `{type:"result", ...}` object, so this stays the single source
 * of truth for the reply text, session id, and error state.
 */
export function parseClaudeResult(stdout: string): ClaudeResult {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("claude CLI produced no output");
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    throw new Error(`claude CLI output was not JSON: ${trimmed.slice(0, 500)}`);
  }
  const subtype = typeof obj.subtype === "string" ? obj.subtype : null;
  return {
    text: typeof obj.result === "string" ? obj.result : "",
    sessionId: typeof obj.session_id === "string" ? obj.session_id : null,
    isError: obj.is_error === true || (subtype !== null && subtype !== "success"),
    subtype,
  };
}

/** A normalized view of one stream-json line, ready to drive the activity feed. */
export type AgentStreamEvent =
  | { kind: "init"; tools: number; mcpServers: string[]; sessionId: string | null }
  | { kind: "assistant"; text: string }
  | { kind: "tool-use"; tool: string; input: string; toolUseId?: string }
  | { kind: "tool-result"; text: string; isError: boolean; toolUseId?: string }
  | { kind: "result"; result: ClaudeResult };

/** Truncate a one-line preview so the feed stays readable. */
export function preview(value: string, max = 240): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

function asText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" && "text" in c && typeof (c as { text: unknown }).text === "string"
          ? (c as { text: string }).text
          : typeof c === "string"
            ? c
            : "",
      )
      .join(" ");
  }
  return "";
}

/**
 * Pure normalization of a single parsed stream-json object into zero or more
 * {@link AgentStreamEvent}s (an assistant message can carry several content
 * blocks). Unknown shapes yield `[]`. Exported for testing.
 */
export function normalizeStreamObject(obj: unknown, rawLine: string): AgentStreamEvent[] {
  if (!obj || typeof obj !== "object") return [];
  const o = obj as Record<string, unknown>;
  const type = o.type;

  if (type === "system" && o.subtype === "init") {
    const tools = Array.isArray(o.tools) ? o.tools.length : 0;
    const servers = Array.isArray(o.mcp_servers)
      ? (o.mcp_servers as Array<{ name?: unknown }>)
          .map((s) => (typeof s?.name === "string" ? s.name : null))
          .filter((n): n is string => n !== null)
      : [];
    return [
      {
        kind: "init",
        tools,
        mcpServers: servers,
        sessionId: typeof o.session_id === "string" ? o.session_id : null,
      },
    ];
  }

  if (type === "assistant") {
    const message = o.message as { content?: unknown } | undefined;
    const blocks = Array.isArray(message?.content) ? (message!.content as unknown[]) : [];
    const events: AgentStreamEvent[] = [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        events.push({ kind: "assistant", text: b.text });
      } else if (b.type === "tool_use" && typeof b.name === "string") {
        events.push({
          kind: "tool-use",
          tool: b.name,
          input: preview(JSON.stringify(b.input ?? {})),
          toolUseId: typeof b.id === "string" ? b.id : undefined,
        });
      }
    }
    return events;
  }

  if (type === "user") {
    const message = o.message as { content?: unknown } | undefined;
    const blocks = Array.isArray(message?.content) ? (message!.content as unknown[]) : [];
    const events: AgentStreamEvent[] = [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "tool_result") {
        events.push({
          kind: "tool-result",
          text: preview(asText(b.content)),
          isError: b.is_error === true,
          toolUseId: typeof b.tool_use_id === "string" ? b.tool_use_id : undefined,
        });
      }
    }
    return events;
  }

  if (type === "result") {
    return [{ kind: "result", result: parseClaudeResult(rawLine) }];
  }

  return [];
}

/**
 * Incrementally parses the CLI's NDJSON stdout. Feed it raw chunks with
 * {@link push}; it splits on newlines, normalizes each complete line, and
 * invokes `onEvent` live. Call {@link end} when the stream closes to flush any
 * trailing partial line. The final reply is available via {@link finalResult}.
 */
export class StreamParser {
  private buffer = "";
  private result: ClaudeResult | null = null;
  /** Maps a tool_use id to its tool name so tool results can be labelled. */
  private readonly toolNames = new Map<string, string>();

  constructor(private readonly onEvent: (event: AgentStreamEvent) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.handleLine(line);
    }
  }

  end(): void {
    if (this.buffer.trim()) this.handleLine(this.buffer);
    this.buffer = "";
  }

  get finalResult(): ClaudeResult | null {
    return this.result;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      // The CLI occasionally interleaves non-JSON diagnostics; ignore them.
      return;
    }
    for (const event of normalizeStreamObject(obj, trimmed)) {
      if (event.kind === "tool-use" && event.toolUseId) {
        this.toolNames.set(event.toolUseId, event.tool);
      }
      if (event.kind === "result") {
        this.result = event.result;
      }
      this.onEvent(event);
    }
  }

  /** Look up the tool name for a tool-result event (set during tool-use). */
  toolNameFor(toolUseId: string | undefined): string | undefined {
    return toolUseId ? this.toolNames.get(toolUseId) : undefined;
  }
}

/** Resolve the bundled `claude` binary (overridable via CLAUDE_BIN). */
function resolveClaudeBin(): string {
  if (process.env.CLAUDE_BIN?.trim()) return process.env.CLAUDE_BIN.trim();
  const pkgPath = require.resolve("@anthropic-ai/claude-code/package.json");
  const pkg = require(pkgPath) as { bin: string | Record<string, string> };
  const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.claude;
  if (!binRel) throw new Error("Could not locate the claude binary in @anthropic-ai/claude-code");
  return path.join(path.dirname(pkgPath), binRel);
}

/**
 * The MCP configs to hand the CLI: just the operator's project `.mcp.json`, if
 * present. That file is the agent's entire tool surface — an MCP aggregator, or
 * individual servers listed directly (e.g. Linear's official hosted MCP server;
 * see `.mcp.example.json`). The daemon adds nothing of its own: its
 * `LINEAR_API_TOKEN` is the poll/post harness credential, kept separate from the
 * agent's tools. `${VAR}` placeholders inside `.mcp.json` are env-expanded by the
 * CLI from the child env at load time, so secrets stay out of the committed file.
 */
function buildMcpConfigs(config: Config): string[] {
  const projectMcp = path.join(config.projectRoot, ".mcp.json");
  return existsSync(projectMcp) ? [projectMcp] : [];
}

/** Context attached to the activity events emitted during a single turn. */
export interface TurnContext {
  issue?: string;
  title?: string;
}

export class AgentSession {
  private readonly claudeBin: string;
  private readonly mcpConfigs: string[];

  constructor(
    private readonly config: Config,
    private readonly state: StateStore,
    private readonly hub?: ActivityHub,
  ) {
    this.claudeBin = resolveClaudeBin();
    this.mcpConfigs = buildMcpConfigs(config);
  }

  /**
   * Run one turn. Returns the agent's final text, which the caller posts back
   * to Linear as the reply. As the turn runs, a normalized view of every
   * message and tool call is emitted to the activity hub (if one is wired in).
   */
  async run(prompt: string, ctx: TurnContext = {}): Promise<string> {
    const args = buildClaudeArgs({
      model: this.config.model,
      permissionMode: this.config.permissionMode,
      allowedTools: this.config.allowedTools,
      disallowedTools: this.config.disallowedTools,
      mcpConfigs: this.mcpConfigs,
      resume: this.state.sessionId ?? undefined,
    });

    const parser = new StreamParser((event) => this.publish(event, ctx, parser));
    await this.exec(args, prompt, parser);

    const result = parser.finalResult;
    if (!result) {
      throw new Error("claude CLI ended without a result line");
    }
    // Capture (or refresh) the session id so the next turn resumes this thread.
    if (result.sessionId) await this.state.setSessionId(result.sessionId);
    if (result.isError) {
      throw new Error(`claude CLI turn failed (${result.subtype ?? "unknown"}): ${result.text || "no detail"}`);
    }
    return result.text.trim();
  }

  /** Translate a normalized stream event into an activity-feed entry. */
  private publish(event: AgentStreamEvent, ctx: TurnContext, parser: StreamParser): void {
    if (!this.hub) return;
    const base = { issue: ctx.issue, title: ctx.title };
    switch (event.kind) {
      case "init":
        this.hub.emit({
          ...base,
          type: "info",
          text: `Agent online — ${event.tools} tools available`,
          detail: event.mcpServers.length ? `MCP: ${event.mcpServers.join(", ")}` : undefined,
        });
        break;
      case "assistant":
        this.hub.emit({ ...base, type: "assistant", text: event.text });
        break;
      case "tool-use":
        this.hub.emit({ ...base, type: "tool-use", tool: event.tool, text: event.input });
        break;
      case "tool-result":
        this.hub.emit({
          ...base,
          type: event.isError ? "error" : "tool-result",
          tool: parser.toolNameFor(event.toolUseId),
          text: event.text,
        });
        break;
      case "result":
        // The final reply is announced by the daemon once it's posted to Linear.
        break;
    }
  }

  /** Spawn the CLI, feed the prompt on stdin, and stream stdout into the parser. */
  private exec(args: string[], prompt: string, parser: StreamParser): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.claudeBin, args, {
        cwd: this.config.projectRoot,
        // The CLI reads ANTHROPIC_API_KEY from the environment (or falls back to
        // its own login when none is set), and expands any ${VAR} placeholders in
        // the operator's .mcp.json (e.g. a server's bearer token) from this env.
        env: buildChildEnv(process.env, this.config.anthropicApiKey),
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stderr = "";
      // Settle exactly once: a SIGKILL timeout also fires `close`, and we must
      // not let the second event overwrite the first outcome.
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        settle(() => reject(new Error(`claude CLI turn timed out after ${TURN_TIMEOUT_MS / 1000}s`)));
      }, TURN_TIMEOUT_MS);

      child.stdout.on("data", (d) => parser.push(d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => settle(() => reject(err)));
      child.on("close", (code) => {
        parser.end();
        settle(() =>
          code === 0
            ? resolve()
            : reject(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 1000)}`)),
        );
      });

      // Pass the (untrusted) comment prompt via stdin, never the command line.
      // If the child has already exited (bad flag, auth failure, …) the pipe is
      // closed; swallow the resulting EPIPE so it can't crash the daemon — the
      // `close`/`error` handler above is what reports the failure.
      child.stdin.on("error", () => {});
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
