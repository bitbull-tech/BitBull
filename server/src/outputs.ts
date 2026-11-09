/**
 * Getting what the agent made out of BitBull without a shell: which files a chat's replies created
 * or changed, and downloads of any workspace file or folder (a folder, or several files, as one
 * .zip). The page saves them like any download, and the link helper can show them in Explorer /
 * Finder.
 */
import { crc32, deflateRawSync } from "node:zlib";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/** Folders that are never "outputs": engine state, dependencies, VCS, read-only links. */
const SKIP = new Set([".claude", ".opencode", ".git", "node_modules", ".venv", "venv", "__pycache__", ".cache", "dist", "build", "target", "links"]);

/** In a download the user picked the folder, so only engine state, VCS and dependencies are left out. */
const SKIP_IN_ZIP = new Set([".claude", ".opencode", ".git", "node_modules", ".venv", "venv", "__pycache__", ".cache"]);

export interface OutputFile {
  /** relative to the workspace, "/" separated */
  path: string;
  size: number;
  mtime: number;
  /** the turn it was written in */
  turn: { start: number; end: number };
}

/**
 * Files in the workspace last written while one of these turns was running. Bounded walk: it
 * stops after `maxEntries` directory entries so a huge workspace can't stall the request.
 */
export function outputsDuring(ws: string, windows: Array<{ start: number; end: number }>, limit = 300, maxEntries = 30_000): OutputFile[] {
  if (!windows.length) return [];
  const slack = 2000; // filesystem timestamps vs. the turn's clock
  const wins = windows.map((w) => ({ start: w.start - slack, end: w.end + slack, turn: w })).sort((a, b) => a.start - b.start);
  const lo = wins[0].start;
  const out: OutputFile[] = [];
  let seen = 0;
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 10 || seen > maxEntries) return;
    let list;
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of list) {
      if (++seen > maxEntries) return;
      if (d.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (!SKIP.has(d.name)) walk(abs, r, depth + 1);
        continue;
      }
      if (!d.isFile()) continue;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.mtimeMs < lo) continue;
      const w = wins.find((x) => st.mtimeMs >= x.start && st.mtimeMs <= x.end);
      if (w) out.push({ path: r, size: st.size, mtime: st.mtimeMs, turn: { start: w.turn.start, end: w.turn.end } });
    }
  };
  walk(ws, "", 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/** An absolute path inside the workspace for a cleaned relative one, or null (outside, a link out, missing). */
export function insideReal(ws: string, rel: string): string | null {
  const abs = path.join(ws, rel);
  try {
    const real = realpathSync(abs);
    const realWs = realpathSync(ws);
    return real === realWs || real.startsWith(realWs + path.sep) ? real : null;
  } catch {
    return null;
  }
}

export const ZIP_LIMITS = { files: 5000, bytes: 512 * 1024 * 1024 };

/** Every file under the given paths (files or folders), skipping engine state and dependencies. */
export function collect(ws: string, rels: string[]): Array<{ abs: string; name: string; size: number; mtime: number }> {
  const out: Array<{ abs: string; name: string; size: number; mtime: number }> = [];
  let bytes = 0;
  const add = (abs: string, name: string) => {
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const d of readdirSync(abs, { withFileTypes: true })) {
        if (d.isSymbolicLink() || (d.isDirectory() && SKIP_IN_ZIP.has(d.name))) continue;
        add(path.join(abs, d.name), `${name}/${d.name}`);
      }
      return;
    }
    if (!st.isFile()) return;
    bytes += st.size;
    if (out.length >= ZIP_LIMITS.files || bytes > ZIP_LIMITS.bytes) throw new Error(`Too much for one download (over ${ZIP_LIMITS.files} files or ${ZIP_LIMITS.bytes / 1024 / 1024} MB): pick a smaller folder`);
    out.push({ abs, name, size: st.size, mtime: st.mtimeMs });
  };
  for (const rel of rels) {
    const abs = insideReal(ws, rel);
    if (!abs) throw new Error(`Not found: ${rel}`);
    // keep the folder's own name at the top of the zip; for the workspace itself use its contents
    add(abs, abs === realpathSync(ws) ? "" : path.basename(abs));
  }
  return out.map((f) => ({ ...f, name: f.name.replace(/^\/+/, "") }));
}

/** DOS date/time for zip headers. */
function dos(ms: number) {
  const d = new Date(ms);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * A plain .zip (deflate, or stored when that's no smaller) that Explorer, Finder and every unzip
 * open. Built in memory: downloads are capped by ZIP_LIMITS.
 */
export function zip(files: Array<{ abs: string; name: string; mtime: number }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const data = readFileSync(f.abs);
    const name = Buffer.from(f.name, "utf8");
    const packed = deflateRawSync(data);
    const store = packed.length >= data.length;
    const body = store ? data : packed;
    const crc = crc32(data) >>> 0;
    const { time, date } = dos(f.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(store ? 0 : 8, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".webm": "video/webm", ".pdf": "application/pdf",
  ".json": "application/json", ".csv": "text/csv", ".md": "text/markdown", ".txt": "text/plain", ".html": "text/html", ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
export const contentType = (name: string) => TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";

/** Content-Disposition for a download: ASCII fallback plus the real (UTF-8) name. */
export function disposition(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
