import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ActivityEvent, ActivityHub } from "./activity.js";

/**
 * A tiny zero-dependency web view of the daemon's live activity.
 *
 * It serves one HTML page and a Server-Sent Events stream. The page opens an
 * `EventSource` to `/events`; the server replays the recent ring buffer (so a
 * browser that connects mid-run isn't staring at a blank screen) and then pushes
 * every new {@link ActivityEvent} as it happens. Put this on screen next to
 * Linear and you can watch Claude work through each comment in real time.
 *
 * Built on Node's `http` module on purpose — no framework, nothing to audit, and
 * it drops straight into the existing single-process daemon.
 */

export interface VizServerOptions {
  hub: ActivityHub;
  /** Project root used to locate `public/index.html`. */
  projectRoot: string;
  /** Heartbeat comment interval (ms) to keep SSE connections alive. */
  heartbeatMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 15_000;

/** Serialize an event as a single SSE message. */
export function formatSse(event: ActivityEvent): string {
  return `id: ${event.id}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`;
}

/** A minimal fallback page if `public/index.html` can't be read. */
const FALLBACK_HTML = `<!doctype html><meta charset="utf-8"><title>Bridge activity</title>
<body style="font:14px monospace;background:#0b0f17;color:#e6edf3;margin:0;padding:16px">
<h1>Bridge activity</h1><pre id="log"></pre>
<script>
const log=document.getElementById('log');
new EventSource('/events').addEventListener('activity',e=>{
  const d=JSON.parse(e.data);
  log.textContent+=\`[\${d.ts}] \${d.type} \${d.issue||''} \${d.tool||''} \${d.text||''}\\n\`;
});
</script>`;

function loadIndexHtml(projectRoot: string): string {
  try {
    return readFileSync(path.join(projectRoot, "public", "index.html"), "utf8");
  } catch {
    return FALLBACK_HTML;
  }
}

/**
 * Build (but do not start) the activity web server. Call `.listen(port, host)`
 * on the returned server. Tests can listen on port 0.
 */
export function createVizServer(opts: VizServerOptions): http.Server {
  const { hub } = opts;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const html = loadIndexHtml(opts.projectRoot);

  return http.createServer((req, res) => {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];

    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }

    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(html);
      return;
    }

    if (pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, buffered: hub.recent().length, subscribers: hub.subscriberCount }));
      return;
    }

    if (pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // Disable proxy buffering so events arrive immediately.
        "X-Accel-Buffering": "no",
      });
      let unsubscribe: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      // Idempotent: may be called on req close, res close/error, or a failed
      // write, possibly more than once.
      const cleanup = () => {
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        unsubscribe = undefined;
      };
      // Writing to a disconnected socket can throw synchronously; tear the
      // connection down cleanly instead of letting it surface unhandled.
      const safeWrite = (chunk: string): void => {
        if (res.writableEnded) {
          cleanup();
          return;
        }
        try {
          res.write(chunk);
        } catch {
          cleanup();
        }
      };
      // Tell the browser how soon to reconnect if the stream drops.
      safeWrite("retry: 3000\n\n");
      // Replay recent context, then subscribe to live events.
      for (const event of hub.recent()) safeWrite(formatSse(event));
      unsubscribe = hub.subscribe((event) => safeWrite(formatSse(event)));
      heartbeat = setInterval(() => safeWrite(": ping\n\n"), heartbeatMs);
      // Don't let the heartbeat timer keep the process alive on its own.
      heartbeat.unref?.();
      // Cover both client-side disconnects (req close) and server/socket
      // teardown (res close/error). cleanup is idempotent.
      req.on("close", cleanup);
      res.on("close", cleanup);
      res.on("error", cleanup);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });
}

/** Create and start the activity web server, resolving once it is listening. */
export function startVizServer(
  opts: VizServerOptions & { port: number; host?: string },
): Promise<http.Server> {
  const server = createVizServer(opts);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
