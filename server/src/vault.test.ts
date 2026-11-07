import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configureVault, lockVault, unlockVault, vaultExists, vaultKeys, vaultSet, vaultUnlocked, vaultValues } from "./vault.js";

const dir = mkdtempSync(path.join(tmpdir(), "bitbull-vault-"));
const file = path.join(dir, "vault.json");
const KEY = "a".repeat(64);
const OTHER = "b".repeat(64);

test("vault: created at first unlock, values encrypted at rest, wrong key refused", () => {
  configureVault(file);
  assert.equal(vaultUnlocked(), false);
  assert.deepEqual(vaultValues(), {});
  assert.throws(() => vaultSet("SAYGM_API_KEY", "x"), /locked/);

  assert.equal(unlockVault(KEY), 0);
  assert.equal(vaultExists(), true);
  vaultSet("SAYGM_API_KEY", "sk-test-1234567890");
  vaultSet("GITHUB_TOKEN", "ghp_abc");
  assert.deepEqual(vaultKeys(), ["GITHUB_TOKEN", "SAYGM_API_KEY"]);

  const raw = readFileSync(file, "utf8");
  assert.ok(!raw.includes("sk-test-1234567890") && !raw.includes("ghp_abc"), "secrets must not be readable in the file");
  assert.ok(!raw.includes("SAYGM_API_KEY"), "even the names are inside the ciphertext");

  lockVault();
  assert.deepEqual(vaultValues(), {});
  assert.throws(() => unlockVault(OTHER), /./, "a wrong key must not open it");
  assert.equal(vaultUnlocked(), false);

  assert.equal(unlockVault(KEY), 2);
  assert.equal(vaultValues().SAYGM_API_KEY, "sk-test-1234567890");
  vaultSet("GITHUB_TOKEN", null);
  assert.deepEqual(vaultKeys(), ["SAYGM_API_KEY"]);
  assert.throws(() => vaultSet("DEFAULT_MODEL", "x"), /not a vault setting/);
  assert.throws(() => unlockVault("nothex"), /64 hex/);
  lockVault();
  rmSync(dir, { recursive: true, force: true });
});
