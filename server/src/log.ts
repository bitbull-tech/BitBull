import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { record, redact, sourceOf } from "./activity.js";
import { config } from "./config.js";

/**
 * Tee console output to <DATA_DIR>/logs/server.log (secrets redacted) and into the activity
 * feed, so logs can be read in the UI without access to the terminal the server runs in.
 */
const dir = path.join(config.dataDir, "logs");
mkdirSync(dir, { recursive: true });
export const logFile = path.join(dir, "server.log");

// Node's experimental-feature notices aren't worth surfacing
const noise = /ExperimentalWarning|EnvHttpProxyAgent is experimental|--trace-warnings/;

for (const level of ["log", "info", "warn", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    orig(...args);
    try {
      const text = redact(format(...args));
      appendFileSync(logFile, `${new Date().toISOString()} ${level.toUpperCase()} ${text}\n`);
      if (!noise.test(text)) {
        const firstLine = text.split("\n")[0];
        record({
          level: level === "error" ? "error" : level === "warn" ? "warn" : "info",
          source: sourceOf(text),
          message: firstLine.replace(/^\[[a-z-]+\]\s*/i, ""),
          ...(text.includes("\n") ? { detail: text } : {}),
        });
      }
    } catch {
      /* never let logging crash the app */
    }
  };
}

// Node prints warnings via process 'warning' events; route real ones to the feed too
process.on("warning", (w) => {
  if (!noise.test(`${w.name} ${w.message}`)) record({ level: "warn", source: "server", message: `${w.name}: ${w.message}` });
});
