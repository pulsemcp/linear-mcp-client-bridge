import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { StateStore } from "./state.js";

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
 * Linear is exposed to the agent as a stdio MCP server (`linear-mcp-server.ts`)
 * launched by the CLI via `--mcp-config`, alongside the operator's `.mcp.json`.
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
    "--output-format",
    "json",
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

/** Parse the single JSON object emitted by `claude --print --output-format json`. */
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
 * How to launch the Linear stdio MCP server. When this module runs compiled
 * (dist/session.js) the sibling is plain JS; under `tsx` (dev) it's TypeScript
 * and needs the tsx loader.
 */
function linearServerLaunch(): { command: string; args: string[] } {
  const isTs = import.meta.url.endsWith(".ts");
  const serverPath = fileURLToPath(new URL(`./linear-mcp-server.${isTs ? "ts" : "js"}`, import.meta.url));
  return isTs
    ? { command: process.execPath, args: ["--import", "tsx", serverPath] }
    : { command: process.execPath, args: [serverPath] };
}

/** The MCP configs to hand the CLI: our Linear server + the project .mcp.json. */
function buildMcpConfigs(config: Config): string[] {
  const { command, args } = linearServerLaunch();
  const linear = JSON.stringify({
    mcpServers: { linear: { type: "stdio", command, args } },
  });
  const configs = [linear];
  const projectMcp = path.join(config.projectRoot, ".mcp.json");
  if (existsSync(projectMcp)) configs.push(projectMcp);
  return configs;
}

export class AgentSession {
  private readonly claudeBin: string;
  private readonly mcpConfigs: string[];

  constructor(
    private readonly config: Config,
    private readonly state: StateStore,
  ) {
    this.claudeBin = resolveClaudeBin();
    this.mcpConfigs = buildMcpConfigs(config);
  }

  /**
   * Run one turn. Returns the agent's final text, which the caller posts back
   * to Linear as the reply.
   */
  async run(prompt: string): Promise<string> {
    const args = buildClaudeArgs({
      model: this.config.model,
      permissionMode: this.config.permissionMode,
      allowedTools: this.config.allowedTools,
      disallowedTools: this.config.disallowedTools,
      mcpConfigs: this.mcpConfigs,
      resume: this.state.sessionId ?? undefined,
    });

    const stdout = await this.exec(args, prompt);
    const result = parseClaudeResult(stdout);

    // Capture (or refresh) the session id so the next turn resumes this thread.
    if (result.sessionId) await this.state.setSessionId(result.sessionId);
    if (result.isError) {
      throw new Error(`claude CLI turn failed (${result.subtype ?? "unknown"}): ${result.text || "no detail"}`);
    }
    return result.text.trim();
  }

  /** Spawn the CLI, feed the prompt on stdin, and collect stdout. */
  private exec(args: string[], prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.claudeBin, args, {
        cwd: this.config.projectRoot,
        // The CLI reads ANTHROPIC_API_KEY from the environment; the Linear MCP
        // subprocess inherits it (and LINEAR_API_TOKEN) from here too.
        env: { ...process.env, ANTHROPIC_API_KEY: this.config.anthropicApiKey },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`claude CLI turn timed out after ${TURN_TIMEOUT_MS / 1000}s`));
      }, TURN_TIMEOUT_MS);

      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`claude CLI exited ${code}: ${(stderr || stdout).slice(0, 1000)}`));
      });

      // Pass the (untrusted) comment prompt via stdin, never the command line.
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
