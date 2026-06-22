import fs from "node:fs/promises";
import path from "node:path";

/**
 * Durable state for the bridge. Persisting these three values lets the
 * container restart (or be redeployed) without losing its place or its
 * conversational memory:
 *
 *  - `sessionId`   the Claude Agent session to resume, so every ticket shares
 *                  one continuous thread of context.
 *  - `lastSeen`    the createdAt of the newest comment we've processed, used
 *                  as the polling cursor.
 *  - `processedIds` a short ring buffer of recent comment ids, to dedupe
 *                  across the boundary of equal timestamps.
 */
export interface BridgeState {
  sessionId: string | null;
  lastSeen: string;
  processedIds: string[];
}

const MAX_PROCESSED_IDS = 500;

export class StateStore {
  private readonly file: string;
  private state: BridgeState;

  private constructor(file: string, state: BridgeState) {
    this.file = file;
    this.state = state;
  }

  static async load(stateDir: string, nowIso: string): Promise<StateStore> {
    const file = path.join(stateDir, "state.json");
    await fs.mkdir(stateDir, { recursive: true });
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as Partial<BridgeState>;
      return new StateStore(file, {
        sessionId: parsed.sessionId ?? null,
        // Default the cursor to "now" so a fresh deploy only answers comments
        // that arrive after it comes online.
        lastSeen: parsed.lastSeen ?? nowIso,
        processedIds: parsed.processedIds ?? [],
      });
    } catch {
      return new StateStore(file, { sessionId: null, lastSeen: nowIso, processedIds: [] });
    }
  }

  get sessionId(): string | null {
    return this.state.sessionId;
  }

  get lastSeen(): string {
    return this.state.lastSeen;
  }

  alreadyProcessed(commentId: string): boolean {
    return this.state.processedIds.includes(commentId);
  }

  async setSessionId(sessionId: string): Promise<void> {
    if (this.state.sessionId === sessionId) return;
    this.state.sessionId = sessionId;
    await this.flush();
  }

  /** Record that a comment was handled and advance the cursor. */
  async markProcessed(commentId: string, createdAt: string): Promise<void> {
    if (!this.state.processedIds.includes(commentId)) {
      this.state.processedIds.push(commentId);
      if (this.state.processedIds.length > MAX_PROCESSED_IDS) {
        this.state.processedIds = this.state.processedIds.slice(-MAX_PROCESSED_IDS);
      }
    }
    if (createdAt > this.state.lastSeen) {
      this.state.lastSeen = createdAt;
    }
    await this.flush();
  }

  private async flush(): Promise<void> {
    await fs.writeFile(this.file, JSON.stringify(this.state, null, 2), "utf8");
  }
}
