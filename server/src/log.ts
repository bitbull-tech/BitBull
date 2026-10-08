import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { config } from "./config.js";

/**
 * Tee console output to <DATA_DIR>/logs/server.log (secrets redacted) so logs can be
 * inspected without access to the terminal the server runs in.
 */
const dir = path.join(config.dataDir, "logs");
mkdirSync(dir, { recursive: true });
export const logFile = path.join(dir, "server.log");

const secrets = [config.saygm.apiKey, config.ditto.apiKey, config.appToken].filter((s) => s && s.length > 6);
const redact = (s: string) => secrets.reduce((acc, k) => acc.split(k).join("[REDACTED]"), s);

for (const level of ["log", "info", "warn", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    orig(...args);
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${level.toUpperCase()} ${redact(format(...args))}\n`);
    } catch {
      /* never let logging crash the app */
    }
  };
}
