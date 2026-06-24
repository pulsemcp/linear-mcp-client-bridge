/**
 * The daemon's live activity stream.
 *
 * Every interesting thing the bridge does — polling Linear, picking up a
 * comment, each message the agent works through, the reply it posts — is emitted
 * here as a small structured {@link ActivityEvent}. The web view (`web.ts`)
 * subscribes and streams these to the browser over SSE, giving a pretty,
 * real-time "what is Claude doing right now" feed you can put on screen next to
 * Linear.
 *
 * The hub keeps a bounded ring buffer of recent events so a browser that
 * connects mid-run still gets immediate context instead of a blank screen.
 */

/** The kinds of activity the feed knows how to render. */
export type ActivityType =
  | "info" // generic daemon lifecycle line (startup, auth, shutdown)
  | "poll" // a heartbeat: polled Linear for new comments
  | "comment" // a new comment was picked up and handed to the agent
  | "turn-start" // the agent began working on a comment
  | "assistant" // a chunk of the agent's own reasoning/text
  | "tool-use" // the agent called a tool
  | "tool-result" // a tool returned
  | "reply" // the final reply was posted back to Linear
  | "skip" // a comment was intentionally not answered
  | "error"; // something failed

/** A single event in the activity feed. `id` is monotonic per process. */
export interface ActivityEvent {
  id: number;
  ts: string; // ISO-8601
  type: ActivityType;
  /** Issue identifier this event relates to, e.g. "ENG-42". */
  issue?: string;
  /** Issue title, for context in the feed header. */
  title?: string;
  /** Who/what the event is about — a comment author, a tool name, etc. */
  actor?: string;
  /** The human-readable body of the event (message text, snippet, reason). */
  text?: string;
  /** Tool name for tool-use / tool-result events. */
  tool?: string;
  /** Secondary detail — a URL, a truncated tool input, a session id. */
  detail?: string;
}

/** What a caller supplies; the hub stamps `id` and `ts`. */
export type ActivityInput = Omit<ActivityEvent, "id" | "ts"> & { ts?: string };

type Listener = (event: ActivityEvent) => void;

/** Keep this many recent events so late subscribers still see context. */
const DEFAULT_BUFFER = 300;

export class ActivityHub {
  private seq = 0;
  private readonly buffer: ActivityEvent[] = [];
  private readonly listeners = new Set<Listener>();

  constructor(private readonly bufferSize: number = DEFAULT_BUFFER) {}

  /** Record an event, append it to the ring buffer, and fan it out live. */
  emit(input: ActivityInput): ActivityEvent {
    const event: ActivityEvent = {
      ...input,
      id: ++this.seq,
      ts: input.ts ?? new Date().toISOString(),
    };
    this.buffer.push(event);
    if (this.buffer.length > this.bufferSize) {
      this.buffer.splice(0, this.buffer.length - this.bufferSize);
    }
    // A listener that throws must not wedge the daemon or other listeners.
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* ignore a broken subscriber (e.g. a closed SSE socket) */
      }
    }
    return event;
  }

  /** The recent events, oldest first — replayed to a freshly-connected client. */
  recent(): ActivityEvent[] {
    return this.buffer.slice();
  }

  /** Subscribe to live events. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Number of active subscribers (handy for tests/diagnostics). */
  get subscriberCount(): number {
    return this.listeners.size;
  }
}
