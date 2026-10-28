#!/usr/bin/env node
/**
 * Ingest a pile of scans (phone photos, scanner PDFs, flatbed images) into a project archive
 * the agent and the archive-ingest skill can work from. Runs inside the sandbox; the agent
 * calls it, or the user does from a chat ("ingest the inbox").
 *
 *   node tools/ingest.mjs <inbox> [--out <dir>] [--no-ocr] [--lang eng] [--dry-run]
 *
 *   <inbox>   where the scans are: a linked folder (/links/<name>, read-only), uploads/<x>,
 *             or any folder in the workspace. Scanned recursively. Never modified.
 *   --out     the archive to build, default ./archive (in the workspace). Re-running only
 *             processes files not seen before (by content hash), so the inbox can keep growing.
 *
 * For every new file:
 *   - sha256 (duplicates are recorded once, with every path they were seen at)
 *   - dates/camera/GPS from exiftool, page count from pdfinfo (when installed)
 *   - text: pdftotext for PDFs, tesseract for images (when installed); kept as evidence,
 *     never as fact: OCR of old documents is wrong often enough that every reading must be
 *     checked against the image before it is used.
 *   - the file is COPIED into <out>/items/<id>/original.<ext> (the inbox may be read-only and
 *     may be someone's phone folder; the archive is the working copy)
 * and writes <out>/manifest.json + <out>/manifest.md (one row per item, with "needs a look"
 * flags: no text found, tiny file, duplicate, unreadable).
 *
 * Nothing here talks to the network or to a model.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !["no-ocr", "dry-run"].includes(args[i - 1].slice(2))));
const inbox = positional[0];
if (!inbox) {
  console.error("usage: node tools/ingest.mjs <inbox> [--out archive] [--no-ocr] [--lang eng] [--dry-run]");
  process.exit(2);
}
const out = path.resolve(opt("out", "archive"));
const lang = opt("lang", "eng");
const ocr = !flag("no-ocr");
const dry = flag("dry-run");

const have = (bin) => spawnSync("which", [bin], { stdio: "ignore" }).status === 0;
const tools = { exiftool: have("exiftool"), tesseract: have("tesseract"), pdftotext: have("pdftotext"), pdfinfo: have("pdfinfo") };

const IMAGE = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp", ".heic", ".bmp", ".gif"]);
const DOC = new Set([".pdf"]);
const VIDEO = new Set([".mp4", ".mov", ".m4v", ".avi", ".mkv", ".mts", ".3gp"]);
const AUDIO = new Set([".mp3", ".m4a", ".wav", ".aac", ".ogg"]);
const SKIP_DIRS = new Set([".git", "node_modules", "@eaDir", ".thumbnails", "archive"]);
const SKIP_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function walk(dir, list = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith("._")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && path.resolve(p) !== out) walk(p, list);
    } else if (e.isFile() && !SKIP_FILES.has(e.name)) list.push(p);
  }
  return list;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function run(bin, a, maxBuffer = 64 * 1024 * 1024) {
  try {
    return execFileSync(bin, a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer, timeout: 120_000 });
  } catch {
    return "";
  }
}

function exif(file) {
  if (!tools.exiftool) return {};
  const raw = run("exiftool", ["-j", "-n", "-DateTimeOriginal", "-CreateDate", "-ModifyDate", "-Make", "-Model", "-ImageWidth", "-ImageHeight", "-GPSLatitude", "-GPSLongitude", "-Orientation", "-Duration", file]);
  try {
    const j = JSON.parse(raw)[0] ?? {};
    const date = j.DateTimeOriginal ?? j.CreateDate ?? j.ModifyDate;
    return {
      ...(date ? { captured: String(date) } : {}),
      ...(j.Make || j.Model ? { camera: [j.Make, j.Model].filter(Boolean).join(" ") } : {}),
      ...(j.ImageWidth ? { width: j.ImageWidth, height: j.ImageHeight } : {}),
      ...(j.GPSLatitude !== undefined ? { gps: [j.GPSLatitude, j.GPSLongitude] } : {}),
      ...(j.Duration ? { duration: j.Duration } : {}),
    };
  } catch {
    return {};
  }
}

function textOf(file, ext) {
  if (!ocr) return { text: "", how: "skipped" };
  if (DOC.has(ext)) {
    if (!tools.pdftotext) return { text: "", how: "pdftotext not installed" };
    const t = run("pdftotext", ["-layout", file, "-"]);
    if (t.trim().length > 20) return { text: t, how: "pdftotext (embedded text)" };
    // a scanned PDF has no text layer: OCR the pages via pdftoppm if present
    if (have("pdftoppm") && tools.tesseract) {
      const tmp = path.join(out, ".tmp", String(process.pid));
      mkdirSync(tmp, { recursive: true });
      run("pdftoppm", ["-r", "200", "-png", file, path.join(tmp, "p")]);
      const pages = readdirSync(tmp).filter((f) => f.endsWith(".png")).sort();
      const parts = pages.map((p) => run("tesseract", [path.join(tmp, p), "-", "-l", lang, "--psm", "6"]));
      for (const p of pages) try { execFileSync("rm", ["-f", path.join(tmp, p)]); } catch { /* ignore */ }
      return { text: parts.join("\n\f\n"), how: `tesseract on ${pages.length} rendered page(s)` };
    }
    return { text: "", how: "no text layer and no OCR available" };
  }
  if (IMAGE.has(ext)) {
    if (!tools.tesseract) return { text: "", how: "tesseract not installed" };
    if (ext === ".heic") return { text: "", how: "HEIC: convert to JPEG first (tesseract can't read it)" };
    return { text: run("tesseract", [file, "-", "-l", lang, "--psm", "6"]), how: "tesseract" };
  }
  return { text: "", how: "not text" };
}

const kindOf = (ext) => (IMAGE.has(ext) ? "image" : DOC.has(ext) ? "pdf" : VIDEO.has(ext) ? "video" : AUDIO.has(ext) ? "audio" : "other");

// ---------- manifest ----------
const manifestFile = path.join(out, "manifest.json");
let manifest = { version: 1, items: [], sources: [] };
if (existsSync(manifestFile)) {
  try {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch {
    console.error(`ingest: ${manifestFile} is unreadable; starting a new manifest (the old one is kept as manifest.json.bad)`);
    copyFileSync(manifestFile, manifestFile + ".bad");
    manifest = { version: 1, items: [], sources: [] };
  }
}
const byHash = new Map(manifest.items.map((i) => [i.sha256, i]));
const inboxAbs = path.resolve(inbox);
if (!existsSync(inboxAbs) || !statSync(inboxAbs).isDirectory()) {
  console.error(`ingest: not a folder: ${inbox}`);
  process.exit(2);
}
if (!manifest.sources.includes(inboxAbs)) manifest.sources.push(inboxAbs);

const files = walk(inboxAbs).sort();
console.log(`ingest: ${files.length} file(s) under ${inboxAbs}; tools: ${Object.entries(tools).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}${dry ? " (dry run)" : ""}`);

let added = 0, dup = 0, skipped = 0;
const nextId = () => `item-${String(manifest.items.length + 1).padStart(4, "0")}`;

for (const file of files) {
  const rel = path.relative(inboxAbs, file);
  const ext = path.extname(file).toLowerCase();
  let size;
  try {
    size = statSync(file).size;
  } catch {
    skipped++;
    continue;
  }
  if (size === 0) {
    skipped++;
    continue;
  }
  let hash;
  try {
    hash = sha256(file);
  } catch (e) {
    console.error(`ingest: can't read ${rel}: ${e.message}`);
    skipped++;
    continue;
  }
  const seen = byHash.get(hash);
  if (seen) {
    const where = `${inboxAbs}/${rel}`;
    if (!seen.seen_at.includes(where)) {
      seen.seen_at.push(where);
      seen.flags = [...new Set([...(seen.flags ?? []), "duplicate"])];
      dup++;
    }
    continue;
  }
  const id = nextId();
  const item = {
    id,
    sha256: hash,
    kind: kindOf(ext),
    ext,
    bytes: size,
    name: path.basename(file),
    seen_at: [`${inboxAbs}/${rel}`],
    added: new Date().toISOString(),
    original: `items/${id}/original${ext}`,
    flags: [],
  };
  if (!dry) {
    const dir = path.join(out, "items", id);
    mkdirSync(dir, { recursive: true });
    copyFileSync(file, path.join(dir, `original${ext}`));
    Object.assign(item, exif(file));
    if (DOC.has(ext) && tools.pdfinfo) {
      const m = /Pages:\s+(\d+)/.exec(run("pdfinfo", [file]));
      if (m) item.pages = Number(m[1]);
    }
    const { text, how } = textOf(file, ext);
    item.text_how = how;
    if (text.trim()) {
      writeFileSync(path.join(dir, "text.txt"), text);
      item.text = `items/${id}/text.txt`;
      item.text_chars = text.trim().length;
    } else if (item.kind === "image" || item.kind === "pdf") item.flags.push("no text found");
    // a scan of a page is hundreds of thousands of pixels; a thumbnail or icon isn't
    if (item.kind === "image" && (item.width ? item.width * item.height < 250_000 : size < 20_000)) item.flags.push("small image: thumbnail or blank?");
  }
  manifest.items.push(item);
  byHash.set(hash, item);
  added++;
  console.log(`  + ${id}  ${rel}${item.text_chars ? `  (${item.text_chars} chars of text)` : ""}${item.flags.length ? `  [${item.flags.join("; ")}]` : ""}`);
}

if (!dry) {
  mkdirSync(out, { recursive: true });
  manifest.updated = new Date().toISOString();
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  const rows = manifest.items.map(
    (i) => `| ${i.id} | ${i.kind} | ${i.captured ?? ""} | ${i.name} | ${i.pages ? `${i.pages} p` : i.width ? `${i.width}×${i.height}` : ""} | ${i.text_chars ?? ""} | ${(i.flags ?? []).join("; ")} |`,
  );
  const needs = manifest.items.filter((i) => i.flags?.length);
  writeFileSync(
    path.join(out, "manifest.md"),
    [
      `# Archive manifest`,
      ``,
      `${manifest.items.length} item(s) from ${manifest.sources.length} inbox folder(s), updated ${manifest.updated}.`,
      `Originals under \`items/<id>/\`; extracted text beside them as \`text.txt\` (OCR: evidence, not fact; check against the image).`,
      ``,
      `| id | kind | captured | file | size/pages | text chars | needs a look |`,
      `|---|---|---|---|---|---|---|`,
      ...rows,
      ``,
      needs.length ? `## Needs a look (${needs.length})\n\n${needs.map((i) => `- ${i.id} ${i.name}: ${i.flags.join("; ")}`).join("\n")}` : `## Needs a look\n\nNothing flagged.`,
      ``,
    ].join("\n"),
  );
}
console.log(`ingest: ${added} added, ${dup} duplicate(s), ${skipped} skipped; ${manifest.items.length} item(s) in ${out}`);
