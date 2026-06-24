import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { LinearClient, type LinearComment } from "./linear.js";
import { StateStore } from "./state.js";
import { AgentSession } from "./session.js";
import { classifyComment } from "./filter.js";
import { buildPrompt } from "./prompt.js";

/**
 * One-shot end-to-end smoke test for the bridge.
 *
 * Where `index.ts` is the long-running daemon, this runs a SINGLE cycle and
 * exits: it polls Linear once, picks the most recent comment it would actually
 * answer, runs one real agent turn, and posts the reply (or just prints it with
 * `--dry-run`). That makes "does the whole loop work end to end?" a single
 * command against a real workspace.
 *
 *   npm run smoke                       # newest answerable comment in last 2h
 *   npm run smoke -- --dry-run          # ...but print the reply instead of posting
 *   npm run smoke -- --issue ENG-12     # ...restricted to one issue
 *   npm run smoke -- --lookback-min 30  # ...widen/narrow the search window
 *
 * Anthropic auth follows the same rule as the daemon: set ANTHROPIC_API_KEY to
 * pin a key, or leave it unset to use the host's own `claude` login.
 */

export interface SmokeOptions {
  dryRun: boolean;
  issue?: string;
  lookbackMinutes: number;
}

/** Parse the smoke CLI flags (exported for testing). */
export function parseSmokeArgs(argv: string[]): SmokeOptions {
  const opts: SmokeOptions = { dryRun: false, lookbackMinutes: 120 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--issue") opts.issue = argv[++i];
    else if (arg === "--lookback-min") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) opts.lookbackMinutes = n;
    }
  }
  return opts;
}

/**
 * Choose which comment a smoke run should answer: the most recent one the
 * daemon's own rules would `handle` (not our own, in-scope for the configured
 * teams), optionally restricted to a single issue. Pure, so it can be tested
 * without the network. `comments` is expected oldest-first, as
 * `fetchCommentsSince` returns them, so the last match is the newest.
 */
export function pickSmokeComment(
  comments: LinearComment[],
  viewerId: string,
  teamKeys: string[],
  issueFilter?: string,
): LinearComment | null {
  const wanted = issueFilter?.toLowerCase();
  let chosen: LinearComment | null = null;
  for (const c of comments) {
    if (classifyComment(c, viewerId, teamKeys, () => false) !== "handle") continue;
    if (wanted && c.issueIdentifier.toLowerCase() !== wanted) continue;
    chosen = c; // keep advancing → ends on the newest match
  }
  return chosen;
}

function preview(body: string, max = 200): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max) + "…";
}

async function main(): Promise<void> {
  const opts = parseSmokeArgs(process.argv.slice(2));
  const config = loadConfig();

  const linear = new LinearClient(config);
  const viewer = await linear.getViewer();
  console.log(`Authenticated with Linear as "${viewer.name}" (${viewer.id}).`);
  console.log(
    config.anthropicApiKey
      ? "Anthropic auth: using ANTHROPIC_API_KEY."
      : "Anthropic auth: no ANTHROPIC_API_KEY set — using the claude CLI's own login.",
  );

  const since = new Date(Date.now() - opts.lookbackMinutes * 60_000).toISOString();
  console.log(
    `Looking for comments since ${since}` +
      (opts.issue ? ` on issue ${opts.issue}` : "") +
      ` …`,
  );
  const comments = await linear.fetchCommentsSince(since);
  const chosen = pickSmokeComment(comments, viewer.id, config.teamKeys, opts.issue);

  if (!chosen) {
    console.log(
      `No answerable comment found (${comments.length} fetched in the window). ` +
        `Remember: comments authored by the bot's own token are skipped — post the ` +
        `test comment as a different Linear user.`,
    );
    return;
  }

  console.log(
    `→ ${chosen.issueIdentifier} "${chosen.issueTitle}" — comment from ${chosen.authorName}:`,
  );
  console.log(`   ${preview(chosen.body)}`);

  // Isolate smoke state so a test run never disturbs the daemon's real session
  // id or poll cursor.
  const stateDir = process.env.SMOKE_STATE_DIR?.trim() || path.join(config.stateDir, "smoke");
  const state = await StateStore.load(stateDir, new Date().toISOString());
  const agent = new AgentSession(config, state);

  console.log("Running one agent turn…");
  const reply = await agent.run(buildPrompt(chosen));

  if (!reply) {
    console.log("Agent produced an empty reply; nothing to post.");
    return;
  }

  if (opts.dryRun) {
    console.log("\n--- DRY RUN: reply NOT posted ---\n");
    console.log(reply);
    return;
  }

  const url = await linear.createComment(chosen.issueId, reply);
  console.log(`\n← Posted reply on ${chosen.issueIdentifier}: ${url}`);
}

// Only run when invoked directly (`npm run smoke`), not when imported by tests
// for the pure helpers above.
const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error("Smoke run failed:", err);
    process.exit(1);
  });
}
