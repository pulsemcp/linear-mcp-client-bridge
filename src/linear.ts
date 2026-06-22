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

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export class LinearClient {
  private readonly url: string;
  private readonly token: string;

  constructor(config: Config) {
    this.url = config.linearApiUrl;
    this.token = config.linearApiToken;
  }

  private async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.url, {
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

  /** Comments created strictly after `sinceIso`, oldest first. */
  async fetchCommentsSince(sinceIso: string): Promise<LinearComment[]> {
    const query = `
      query NewComments($since: DateTimeOrDuration!) {
        comments(
          filter: { createdAt: { gt: $since } }
          first: 50
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
        }
      }
    `;
    const data = await this.request<{
      comments: {
        nodes: Array<{
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
        }>;
      };
    }>(query, { since: sinceIso });

    return data.comments.nodes
      .filter((n) => n.issue != null)
      .map((n) => ({
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
      }));
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
