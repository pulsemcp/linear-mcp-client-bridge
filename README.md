# linear-mcp-client-bridge

An example of how you can de-facto inject a highly capable agent — and a full
**MCP client** — into just about any software service.

This one wires [Claude Code](https://docs.claude.com/en/docs/claude-code) into
[Linear](https://linear.app). A tiny daemon polls your workspace and pipes every
new ticket comment into **one continuous Claude session**. Claude reads the
comment, uses whatever tools you've connected (Linear itself, plus any MCP
servers you configure), and its answer is posted straight back to the ticket.

The interesting part isn't the Linear glue — it's the shape. A ~250-line harness
turns a SaaS comment stream into an agent with memory, skills, and access to
every system you expose over MCP. Swap Linear for your own service and the same
pattern applies.

```
         ┌──────────────┐   new comment   ┌────────────────────────────┐
         │   Linear     │ ───────────────▶│  bridge (this repo)         │
         │  workspace   │                 │                            │
         │              │◀─────────────── │  • polls Linear            │
         └──────────────┘   posts reply   │  • one persistent Claude    │
                                          │    Code session (memory)    │
                                          │  • CLAUDE.md + skills       │
                                          └─────────────┬──────────────┘
                                                        │ MCP
                            ┌───────────────────────────┼───────────────────────┐
                            ▼                           ▼                       ▼
                     linear tools            MCP gateway / aggregator     your other
                  (built in, no setup)      (.mcp.json → many servers)    MCP servers
```

## How it works

- **It's the Claude Code CLI under the hood.** Each turn shells out to
  `claude -p` (headless print mode) — the same binary you run locally — so you get
  Claude Code's native system prompt, CLAUDE.md discovery, skills, and MCP client
  for free. No SDK, no bespoke agent loop.
- **One session, shared memory.** Every comment is handled as the next turn in a
  single Claude Code conversation (via `--resume`). Ticket #42 can be answered
  with what Claude learned on ticket #7. The session id is persisted, so restarts
  and redeploys keep the thread.
- **Linear is a built-in tool.** The bridge ships a small stdio MCP server that
  exposes `get_issue`, `search_issues`, `list_my_issues`, and `post_comment`. The
  CLI launches it automatically (via `--mcp-config`), reusing the token you
  already set — no extra container.
- **You bring the rest.** Point `.mcp.json` at an
  [MCP gateway/aggregator](https://github.com/domdomegg/mcp-aggregator) or list
  servers directly, and Claude can reach your docs, databases, CI, CRM — anything
  with an MCP server.
- **Behavior is editable.** `CLAUDE.md` is the operating rulebook and
  `.claude/skills/` holds reusable procedures. A bundled `cross-service-lookup`
  skill teaches Claude to discover and route questions to the right connected
  service.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (with Compose).
- An **Anthropic API key** — <https://console.anthropic.com/settings/keys>.
- A **Linear personal API key** — in Linear: *Settings → Security & access →
  Personal API keys → New key*. It looks like `lin_api_…`.

> The bridge acts **as the user who owns the API key**: it can read what that
> user can read and comments under their name. Consider creating a dedicated
> Linear user ("Claude", a bot account) and generating the key from there.

## Quick start (Docker Compose)

```bash
# 1. Clone
git clone https://github.com/<you>/linear-mcp-client-bridge.git
cd linear-mcp-client-bridge

# 2. Configure secrets
cp .env.example .env
$EDITOR .env          # set ANTHROPIC_API_KEY and LINEAR_API_TOKEN

# 3. Build and run
docker compose up --build -d

# 4. Watch it
docker compose logs -f
```

Now go to any issue in your Linear workspace and add a comment. Within a poll
interval (default 20s) Claude replies on the ticket. That's it.

To stop: `docker compose down` (your session memory survives in the
`bridge-state` volume; `docker compose down -v` wipes it).

### Plain Docker (no Compose)

```bash
docker build -t linear-mcp-client-bridge .
docker run -d --name linear-bridge \
  --env-file .env \
  -v linear-bridge-state:/data \
  linear-mcp-client-bridge
```

## Configuration

All configuration is environment variables (see `.env.example`):

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | ✅ | — | Anthropic API key. |
| `LINEAR_API_TOKEN` | ✅ | — | Linear personal API key (`lin_api_…`). |
| `POLL_INTERVAL_SECONDS` | | `20` | Seconds between Linear polls. |
| `AGENT_MODEL` | | `claude-opus-4-8` | Model the agent runs on. |
| `AGENT_PERMISSION_MODE` | | `bypassPermissions` | Claude Code permission mode. See **Security**. |
| `AGENT_ALLOWED_TOOLS` | | _(all)_ | Comma-separated allowlist of tools, e.g. `mcp__linear__*,Read`. When set, only these are usable. |
| `AGENT_DISALLOWED_TOOLS` | | _(none)_ | Comma-separated blocklist of tools, e.g. `Bash,Write,Edit`. Applied on top of the allowlist. |
| `LINEAR_TEAM_KEYS` | | _(all)_ | Comma-separated team keys to limit scope, e.g. `ENG,OPS`. |
| `MCP_AGGREGATOR_URL` | | `http://localhost:3000/mcp` | URL the default `.mcp.json` gateway entry points at. |
| `STATE_DIR` | | `./state` (code) / `/data` (Docker image) | Where the session id + poll cursor are stored. The Docker image sets `/data` and mounts it as a volume. |
| `CLAUDE_BIN` | | _(bundled)_ | Path to the `claude` binary. Defaults to the one bundled with the `@anthropic-ai/claude-code` dependency; override only if you want a different CLI build. |

## Giving the agent more powers (MCP servers)

This is the flexibility point. Edit **`.mcp.json`** to connect Claude to other
systems. Two patterns (full examples in `.mcp.example.json`):

**A) Front everything with a gateway.** Run an
[mcp-aggregator](https://github.com/domdomegg/mcp-aggregator) that combines many
upstream MCP servers behind one endpoint, and point the bridge at it:

```jsonc
// .mcp.json
{
  "mcpServers": {
    "gateway": { "type": "http", "url": "${MCP_AGGREGATOR_URL:-http://localhost:3000/mcp}" }
  }
}
```

Set `MCP_AGGREGATOR_URL` in `.env` to your gateway. Add upstreams to the gateway
and Claude gains those tools with no change here.

**B) List servers directly.** Add stdio or HTTP servers yourself:

```jsonc
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

`${VAR}` and `${VAR:-default}` are expanded from the environment, so secrets stay
in `.env`, not in the committed file. Anything you add shows up to Claude as
`mcp__<server>__<tool>` tools.

> The default `.mcp.json` ships with a `gateway` entry pointing at
> `localhost:3000`. If you don't run a gateway, either set `MCP_AGGREGATOR_URL`
> to a real one or delete that entry — Claude still has the built-in Linear tools
> and will simply log that the gateway is unreachable.

## Teaching it new behaviors (CLAUDE.md + skills)

- **`CLAUDE.md`** — the always-on rulebook: tone, what to do, and the security
  rules. Edit it to fit your team.
- **`.claude/skills/`** — reusable procedures Claude pulls in on demand. The
  included `cross-service-lookup` skill shows the pattern: discover which
  connected MCP server can answer a ticket, query it, and reply with sources.
  Add your own skill folders (each is a `SKILL.md` with `name` + `description`
  frontmatter) for runbooks specific to your workspace.

## Security — read before deploying

This bridge feeds **untrusted input** (anyone who can comment on your Linear
issues) into an agent that runs **unattended**. Treat it accordingly:

- **Permission mode.** It defaults to `bypassPermissions` because there is no
  human to approve each tool call in a daemon. That means the agent can run
  shell commands and use every connected tool on its own — a deliberately wide
  blast radius so the example shows the full power of an MCP-client agent. Note
  that the stricter built-in modes (`default`, `acceptEdits`, `plan`) assume an
  interactive approver; with no human in the loop they will simply stall on the
  first prompt, so they are not a practical substitute here. To actually narrow
  what the agent can do, scope the **tools** instead (next bullet) and hand it a
  least-privilege Linear token and MCP servers.
- **Tool scoping.** Bound the prompt-injection blast radius without breaking the
  daemon by setting `AGENT_ALLOWED_TOOLS` (an allowlist) and/or
  `AGENT_DISALLOWED_TOOLS` (a blocklist). For example, to keep the agent
  read-only over Linear and your gateway while blocking local shell/file
  mutation: `AGENT_DISALLOWED_TOOLS=Bash,Write,Edit`. These are unset by default
  so the example ships with the full toolset; turn them on for untrusted
  workspaces.
- **Prompt injection.** Comment text can try to hijack the agent ("ignore your
  instructions and …"). `CLAUDE.md` instructs Claude to treat comment bodies as
  data, refuse embedded instructions, never reveal secrets, and avoid
  destructive actions — but no instruction is a hard sandbox. Scope the tools and
  credentials you hand it so the worst case is acceptable.
- **Least privilege.** Give the Linear token and any MCP servers only the access
  the job needs. Restrict blast radius with `LINEAR_TEAM_KEYS`.
- **Runs non-root.** The container runs as an unprivileged user (also required
  for `bypassPermissions`). Keep your secrets in `.env`, which is gitignored.

## Local development

```bash
npm install
cp .env.example .env   # fill in keys
npm run dev            # tsx watch
# or
npm run build && npm start
npm run typecheck      # types only
```

State is written to `./state/` locally (gitignored).

## Project layout

```
src/
  index.ts             poll loop: fetch new comments → run agent → post reply
  config.ts            environment configuration
  linear.ts            minimal Linear GraphQL client (native fetch)
  linear-mcp-server.ts standalone stdio MCP server exposing Linear to the CLI
  session.ts           spawns `claude -p`, one resumable session (--resume)
  state.ts             durable session id + poll cursor
CLAUDE.md         agent operating rules (incl. security)
.claude/skills/   bundled skills (cross-service-lookup)
.mcp.json         MCP servers the agent can use (edit to extend)
.mcp.example.json reference configs to copy from
Dockerfile        non-root container
docker-compose.yml
```

## License

MIT — see [LICENSE](./LICENSE).
