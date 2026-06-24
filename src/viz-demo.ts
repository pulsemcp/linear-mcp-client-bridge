import { ActivityHub } from "./activity.js";
import { startVizServer } from "./web.js";
import { DEMO_SCRIPT } from "./demo-events.js";

/**
 * Preview/record the activity web view without any live credentials.
 *
 *   npm run viz:demo            # play the scripted run once
 *   npm run viz:demo -- --loop  # replay forever (handy for rehearsing a recording)
 *
 * Open http://localhost:8787 (or $VIZ_PORT) to watch it.
 */

const port = Number(process.env.VIZ_PORT) || 8787;
const loop = process.argv.includes("--loop");
const hub = new ActivityHub();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await startVizServer({ hub, projectRoot: process.cwd(), port });
console.log(`Demo activity view: http://localhost:${port}  (Ctrl+C to stop)`);

let running = true;
process.on("SIGINT", () => {
  running = false;
});

do {
  for (const step of DEMO_SCRIPT) {
    if (!running) break;
    await sleep(step.delayMs);
    hub.emit(step.event);
  }
  if (loop && running) await sleep(4000);
} while (loop && running);

console.log("Demo script finished. Server still running — Ctrl+C to exit.");
