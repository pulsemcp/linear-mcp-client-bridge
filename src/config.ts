import path from "node:path";

/**
 * Runtime configuration, read once from the environment.
 *
 * Only two secrets are strictly required: an Anthropic API key (so the agent
 * can think) and a Linear API token (so the bridge can read and write
 * comments). Everything else has a sensible default.
 */
export interface Config {
  /** Anthropic API key. The Agent SDK reads ANTHROPIC_API_KEY directly too. */
  anthropicApiKey: string;
  /** Linear personal API key (starts with `lin_api_`). */
  linearApiToken: string;
  /** Linear GraphQL endpoint. */
  linearApiUrl: string;
  /** Model the agent runs on. */
  model: string;
  /** Claude Code permission mode. See README "Security" before changing. */
  permissionMode: string;
  /** If set, the agent may ONLY use these tools (e.g. "mcp__linear__*"). */
  allowedTools: string[];
  /** Tools the agent may never use (e.g. "Bash,Write,Edit" to bound injection). */
  disallowedTools: string[];
  /** Seconds between polls of the Linear API. */
  pollIntervalSeconds: number;
  /** Directory where the session id + poll cursor are persisted. */
  stateDir: string;
  /** Project root containing CLAUDE.md, .claude/ and .mcp.json. */
  projectRoot: string;
  /**
   * Only react to comments on issues whose team key is in this list
   * (e.g. "ENG,OPS"). Empty means "every team the token can see".
   */
  teamKeys: string[];
}

/** Parse a comma-separated env value into a trimmed, non-empty list. */
function splitList(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The permission modes Claude Code accepts; we fail fast on anything else. */
const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan"] as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `See .env.example for the full list.`,
    );
  }
  return value.trim();
}

export function loadConfig(): Config {
  const projectRoot = process.env.PROJECT_ROOT
    ? path.resolve(process.env.PROJECT_ROOT)
    : process.cwd();

  const permissionMode = process.env.AGENT_PERMISSION_MODE?.trim() || "bypassPermissions";
  if (!PERMISSION_MODES.includes(permissionMode as (typeof PERMISSION_MODES)[number])) {
    throw new Error(
      `Invalid AGENT_PERMISSION_MODE "${permissionMode}". ` +
        `Expected one of: ${PERMISSION_MODES.join(", ")}.`,
    );
  }

  return {
    anthropicApiKey: required("ANTHROPIC_API_KEY"),
    linearApiToken: required("LINEAR_API_TOKEN"),
    linearApiUrl: process.env.LINEAR_API_URL?.trim() || "https://api.linear.app/graphql",
    model: process.env.AGENT_MODEL?.trim() || "claude-opus-4-8",
    permissionMode,
    allowedTools: splitList(process.env.AGENT_ALLOWED_TOOLS),
    disallowedTools: splitList(process.env.AGENT_DISALLOWED_TOOLS),
    pollIntervalSeconds: Number(process.env.POLL_INTERVAL_SECONDS) || 20,
    stateDir: process.env.STATE_DIR?.trim() || path.join(projectRoot, "state"),
    projectRoot,
    teamKeys: splitList(process.env.LINEAR_TEAM_KEYS).map((s) => s.toUpperCase()),
  };
}
