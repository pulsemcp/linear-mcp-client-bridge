import { loadConfig } from "./config.js";
import { LinearClient } from "./linear.js";
import { StateStore } from "./state.js";
import { AgentSession } from "./session.js";
import { classifyComment } from "./filter.js";
import { buildPrompt } from "./prompt.js";

function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Linear comment bodies have a practical size limit; keep replies well under it.
const MAX_REPLY_CHARS = 60_000;

function capReply(reply: string): string {
  if (reply.length <= MAX_REPLY_CHARS) return reply;
  return reply.slice(0, MAX_REPLY_CHARS - 40) + "\n\n…(reply truncated)";
}

/** Retry a startup call a few times so a brief Linear blip doesn't kill boot. */
async function withStartupRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      log(`! ${label} failed (attempt ${attempt}/5):`, err);
      if (attempt < 5) await sleep(3000 * attempt);
    }
  }
  throw lastErr;
}

async function main(): Promise<void> {
  const config = loadConfig();

  const linear = new LinearClient(config);
  const viewer = await withStartupRetry("Linear auth", () => linear.getViewer());
  log(`Authenticated with Linear as "${viewer.name}" (${viewer.id}).`);
  log(
    config.anthropicApiKey
      ? "Anthropic auth: using ANTHROPIC_API_KEY."
      : "Anthropic auth: no ANTHROPIC_API_KEY set — the claude CLI will use its own login.",
  );

  const state = await StateStore.load(config.stateDir, new Date().toISOString());
  log(`State loaded. Resuming session: ${state.sessionId ?? "(new)"}. Cursor: ${state.lastSeen}.`);
  if (config.teamKeys.length) {
    log(`Restricted to teams: ${config.teamKeys.join(", ")}.`);
  }

  const agent = new AgentSession(config, state);

  let running = true;
  const stop = (signal: string) => {
    log(`Received ${signal}, finishing current poll then exiting.`);
    running = false;
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  log(`Polling every ${config.pollIntervalSeconds}s. Waiting for new comments...`);

  while (running) {
    try {
      const comments = await linear.fetchCommentsSince(state.lastSeen);
      // Oldest first so the conversation stays in chronological order.
      comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

      for (const comment of comments) {
        if (!running) break;

        const decision = classifyComment(
          comment,
          viewer.id,
          config.teamKeys,
          (id) => state.alreadyProcessed(id),
        );
        if (decision === "duplicate") continue;
        if (decision === "self" || decision === "out-of-scope") {
          // Nothing to answer, but record it so the cursor advances past it.
          await state.markProcessed(comment.id, comment.createdAt);
          continue;
        }

        log(`→ ${comment.issueIdentifier}: comment from ${comment.authorName}`);
        try {
          const reply = await agent.run(buildPrompt(comment));
          if (reply) {
            const url = await linear.createComment(comment.issueId, capReply(reply));
            log(`← Replied on ${comment.issueIdentifier}: ${url}`);
          } else {
            log(`← Agent produced no reply for ${comment.issueIdentifier}; skipping.`);
          }
        } catch (err) {
          // Don't let one poison comment wedge the loop forever — log and move on.
          log(`! Failed to handle comment ${comment.id} on ${comment.issueIdentifier}:`, err);
        }
        // Mark processed regardless of outcome so we never reprocess it.
        await state.markProcessed(comment.id, comment.createdAt);
      }
    } catch (err) {
      log("! Poll error:", err);
    }

    // Sleep in short slices so SIGTERM is honoured promptly.
    for (let waited = 0; running && waited < config.pollIntervalSeconds; waited++) {
      await sleep(1000);
    }
  }

  log("Shutdown complete.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
