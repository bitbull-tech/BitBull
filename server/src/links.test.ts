import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// links.ts reads GM_LINKS_PATH at import time
const root = mkdtempSync(path.join(tmpdir(), "gm-links-"));
process.env.GM_LINKS_PATH = root;
const { listLinks, mountFlagsOf, resolveLink } = await import("./links.js");

const src = mkdtempSync(path.join(tmpdir(), "gm-links-src-"));
writeFileSync(path.join(src, "letter.txt"), "1943");
mkdirSync(path.join(root, "photos"));
mkdirSync(path.join(root, "writable"));
writeFileSync(path.join(root, "writable", "x.txt"), "x");
mkdirSync(path.join(root, "unmounted")); // empty: a link whose mount is gone
mkdirSync(path.join(root, "Bad_Name"));
writeFileSync(path.join(root, "Bad_Name", "y"), "y");

// A real read-only mount, like link.ps1 makes (needs root; skipped otherwise)
let mounted = false;
try {
  execFileSync("mount", ["--bind", src, path.join(root, "photos")], { stdio: "ignore" });
  execFileSync("mount", ["-o", "remount,bind,ro", path.join(root, "photos")], { stdio: "ignore" });
  mounted = true;
} catch {
  /* not root */
}
after(() => {
  if (mounted) execFileSync("umount", [path.join(root, "photos")]);
});

test("lists mounted links, skips empty and badly named ones", { skip: !mounted && "needs root to mount" }, () => {
  const names = listLinks().map((l) => l.name);
  assert.deepEqual(names, ["photos", "writable"]);
  const photos = listLinks().find((l) => l.name === "photos")!;
  assert.equal(photos.readOnly, true);
  assert.equal(photos.entries, 1);
});

test("only read-only links can be attached", { skip: !mounted && "needs root to mount" }, () => {
  assert.equal(resolveLink("links/photos")?.path, path.join(root, "photos"));
  assert.equal(resolveLink("/links/photos/")?.name, "photos");
  // a link that isn't on a read-only mount is never handed to the agent
  assert.equal(resolveLink("links/writable"), null);
});

test("attachment refs can't escape the links folder", () => {
  for (const bad of ["links/../etc", "links/photos/../../etc", "links/", "links/a/b", "/etc/passwd", "links/Bad_Name", "uploads/x"]) {
    assert.equal(resolveLink(bad), null, bad);
  }
});

test("mount flags come from the innermost mount", () => {
  const table = [
    { point: "/", opts: ["rw"] },
    { point: "/links", opts: ["ro", "rw"] },
    { point: "/links/a", opts: ["rw", "noexec"] },
    { point: "/links/ab", opts: ["ro", "noexec"] },
  ];
  assert.deepEqual(mountFlagsOf("/links/a", table), { readOnly: false, noExec: true, mountPoint: "/links/a" });
  assert.deepEqual(mountFlagsOf("/links/ab/x", table), { readOnly: true, noExec: true, mountPoint: "/links/ab" });
  assert.equal(mountFlagsOf("/links/abc", table).mountPoint, "/links");
  assert.equal(mountFlagsOf("/data", table).readOnly, false);
});
