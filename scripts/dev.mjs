// Runs the API (tsx watch) and the Vite dev server together. Env comes from ../.env
import { spawn } from "node:child_process";

const run = (name, args) => {
  const p = spawn("npm", args, { stdio: "inherit", env: process.env, shell: process.platform === "win32" });
  p.on("exit", (code) => {
    console.log(`[${name}] exited with ${code}`);
    process.exit(code ?? 0);
  });
  return p;
};

const procs = [run("server", ["--prefix", "server", "run", "dev"]), run("web", ["--prefix", "web", "run", "dev"])];
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => procs.forEach((p) => p.kill(sig)));
