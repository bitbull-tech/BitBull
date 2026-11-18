/**
 * Names that look like keys, passwords or wallets: the same list the linked-folder copy leaves
 * out (scripts/bitbull-wsl/bitbull-links.sh, scripts/bitbull-mac/link.sh). Used wherever BitBull
 * sends files off the machine (Cathedral uploads, QA Hound snapshots, clean-machine archives).
 * secretNames.test.ts checks this list still covers the rsync excludes in bitbull-links.sh.
 */

const NAMES = new Set([
  ".env", ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", ".hippius", ".bittensor",
  ".npmrc", ".pypirc", ".netrc", ".git-credentials", "credentials", "credentials.json", "secrets.json",
  "wallet.dat", "key4.db", "logins.json", "settings.local.json", "login data", "cookies",
]);

const GLOBS: RegExp[] = [
  /^\.env\..*$/, // .env.local, .env.production (templates below stay)
  /^id_(rsa|dsa|ecdsa|ed25519)/,
  /\.(pem|key|pfx|p12|ppk|jks|keystore|kdbx|ovpn|wallet)$/,
  /^wallet.*\.json$/,
  /seed.*\.txt$/,
  /mnemonic/,
];

/** Code and docs named after keys (hotkey.py, hotkeys.ts) are not wallet files. */
const CODE_EXT = /\.(py|pyi|ts|tsx|js|jsx|mjs|cjs|rs|go|rb|java|kt|c|h|cc|cpp|hpp|cs|swift|sh|md|rst|html|css|ipynb)$/;

/** Templates that only show which settings exist; they stay. */
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);

/** True when one file or folder name looks like a key, password store or wallet. */
export function isSecretName(name: string): boolean {
  const low = name.toLowerCase();
  if (ENV_TEMPLATES.has(low)) return false;
  if (NAMES.has(low) || GLOBS.some((re) => re.test(low))) return true;
  // Bittensor wallet files and folders (coldkey, coldkeypub.txt, hotkeys/, coldkey.bak), not code
  return /^(coldkey|hotkey)/.test(low) && !CODE_EXT.test(low);
}

/** The first part of a relative path (folders included) that looks like a secret, or null. */
export function secretPart(rel: string): string | null {
  for (const p of rel.split(/[\\/]/)) if (p && isSecretName(p)) return p;
  return null;
}
