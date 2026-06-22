import type { Config } from "./config.js";

/**
 * A tiny Linear GraphQL client built on the global `fetch`. We deliberately
 * avoid the heavy official SDK — the bridge only needs a handful of queries,
 * and keeping the surface area small keeps the example readable.
 */

export interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  url: string;
  authorId: string | null;
  authorName: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string;
  teamKey: string | null;
}

/** Raw shape of a comment node as returned by the GraphQL query below. */
export interface CommentNode {
  id: string;
  body: string;
  createdAt: string;
  url: string;
  user: { id: string; name: string; displayName: string } | null;
  issue: {
    id: string;
    identifier: string;
    title: string;
    url: string;
    team: { key: string } | null;
  } | null;
}

/** Pure mapper from a GraphQL comment node to our flat LinearComment. */
export function mapCommentNode(n: CommentNode): LinearComment {
  return {
    id: n.id,
    body: n.body,
    createdAt: n.createdAt,
    url: n.url,
    authorId: n.user?.id ?? null,
    authorName: n.user?.displayName || n.user?.name || "Unknown",
    issueId: n.issue!.id,
    issueIdentifier: n.issue!.identifier,
    issueTitle: n.issue!.title,
    issueUrl: n.issue!.url,
    teamKey: n.issue!.team?.key ?? null,
  };
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/** One page of the paginated comments query. */
interface CommentsPage {
  comments: {
    nodes: CommentNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

/** Minimal subset of `fetch` we depend on — swappable in tests. */
export type FetchLike = (url: string, init: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

// Drain at most this many pages per poll (50 comments/page). A backstop against
// runaway pagination; far above any realistic per-interval comment volume.
const MAX_PAGES = 50;

export class LinearClient {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: Config, fetchImpl?: FetchLike) {
    this.url = config.linearApiUrl;
    this.token = config.linearApiToken;
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  private async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Linear personal API keys are sent as the raw key (no "Bearer").
        Authorization: this.token,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Linear API HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    const json = (await res.json()) as GraphQLResponse<T>;
    if (json.errors?.length) {
      throw new Error(`Linear API error: ${json.errors.map((e) => e.message).join("; ")}`);
    }
    if (!json.data) {
      throw new Error("Linear API returned no data");
    }
    return json.data;
  }

  /** The identity behind the API token, so we can ignore our own comments. */
  async getViewer(): Promise<{ id: string; name: string }> {
    const data = await this.request<{ viewer: { id: string; name: string } }>(
      `query { viewer { id name } }`,
    );
    return data.viewer;
  }

  /**
   * Every issue comment created at or after `sinceIso`, returned oldest-first.
   *
   * We drain ALL pages rather than trusting a single page. Linear's default
   * page ordering is not contractually fixed, so a single capped page after a
   * burst or downtime could return the wrong end of the range and silently
   * strip unprocessed comments (the cursor would then advance past them). By
   * draining every page and sorting ascending ourselves, the result is correct
   * regardless of Linear's internal order. The `gte` filter (paired with the
   * caller's processed-id dedup) means a comment sharing the exact millisecond
   * of the cursor is re-seen rather than skipped after a restart. Since the
   * filter restricts to new comments, the set is small in steady state and
   * pagination terminates in one page.
   */
  async fetchCommentsSince(sinceIso: string): Promise<LinearComment[]> {
    const query = `
      query NewComments($since: DateTimeOrDuration!, $after: String) {
        comments(
          filter: { createdAt: { gte: $since } }
          first: 50
          after: $after
          orderBy: createdAt
        ) {
          nodes {
            id
            body
            createdAt
            url
            user { id name displayName }
            issue {
              id
              identifier
              title
              url
              team { key }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;

    const nodes: CommentNode[] = [];
    let after: string | null = null;
    let truncated = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data: CommentsPage = await this.request<CommentsPage>(query, { since: sinceIso, after });

      nodes.push(...data.comments.nodes);
      if (!data.comments.pageInfo.hasNextPage) break;
      after = data.comments.pageInfo.endCursor;
      if (after == null) break;
      if (page === MAX_PAGES - 1) truncated = true;
    }
    if (truncated) {
      // Far beyond any realistic per-poll volume, but never hide a cap: an
      // operator seeing this should shorten the poll interval or raise MAX_PAGES.
      console.warn(
        `[linear] fetchCommentsSince hit the ${MAX_PAGES}-page cap; some new comments were not fetched this cycle.`,
      );
    }

    return nodes
      .filter((n) => n.issue != null)
      .map(mapCommentNode)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Post a comment back onto an issue. Returns the new comment URL. */
  async createComment(issueId: string, body: string): Promise<string> {
    const data = await this.request<{
      commentCreate: { success: boolean; comment: { id: string; url: string } | null };
    }>(
      `mutation CreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment { id url }
        }
      }`,
      { issueId, body },
    );
    if (!data.commentCreate.success || !data.commentCreate.comment) {
      throw new Error("Linear rejected the comment");
    }
    return data.commentCreate.comment.url;
  }

  /** Full detail for one issue, including its comment thread. */
  async getIssue(id: string): Promise<unknown> {
    return this.request(
      `query GetIssue($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          url
          priorityLabel
          state { name type }
          assignee { name displayName }
          team { key name }
          labels { nodes { name } }
          comments(first: 50, orderBy: createdAt) {
            nodes {
              body
              createdAt
              user { name displayName }
            }
          }
        }
      }`,
      { id },
    );
  }

  /** Free-text search across issues. */
  async searchIssues(term: string, limit = 10): Promise<unknown> {
    return this.request(
      `query SearchIssues($term: String!, $first: Int!) {
        searchIssues(term: $term, first: $first) {
          nodes {
            identifier
            title
            url
            state { name }
            team { key }
            assignee { displayName }
          }
        }
      }`,
      { term, first: limit },
    );
  }

  /** Issues assigned to the token's own user. */
  async listMyIssues(limit = 20): Promise<unknown> {
    return this.request(
      `query MyIssues($first: Int!) {
        viewer {
          assignedIssues(
            first: $first
            filter: { state: { type: { nin: ["completed", "canceled"] } } }
          ) {
            nodes {
              identifier
              title
              url
              priorityLabel
              state { name }
              team { key }
            }
          }
        }
      }`,
      { first: limit },
    );
  }
}
