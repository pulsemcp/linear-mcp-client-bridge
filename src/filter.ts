import type { LinearComment } from "./linear.js";

/**
 * What the poll loop should do with a freshly fetched comment.
 *
 * - `self`        — we posted it; never react to ourselves.
 * - `duplicate`   — already handled in a previous cycle.
 * - `out-of-scope`— belongs to a team we were told to ignore.
 * - `handle`      — a real new comment to answer.
 */
export type CommentDecision = "self" | "duplicate" | "out-of-scope" | "handle";

/**
 * Pure classification of a comment, factored out of the poll loop so the
 * skip/dedup/team-scope rules can be tested without the CLI or network.
 *
 * Order matters: the self-check runs first (we must drop our own replies even
 * if somehow unprocessed), then the dedup check, then team scoping.
 */
export function classifyComment(
  comment: Pick<LinearComment, "id" | "authorId" | "teamKey">,
  viewerId: string,
  teamKeys: string[],
  isProcessed: (id: string) => boolean,
): CommentDecision {
  if (comment.authorId === viewerId) return "self";
  if (isProcessed(comment.id)) return "duplicate";
  if (teamKeys.length > 0 && (!comment.teamKey || !teamKeys.includes(comment.teamKey))) {
    return "out-of-scope";
  }
  return "handle";
}
