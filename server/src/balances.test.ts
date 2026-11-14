/**
 * Balances are read from answers whose exact shape isn't documented: an amount is only taken
 * from a field that says what it is, in the unit its name states, and never guessed.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-balances-"));
const { readSaygmCredits, readDittoUsage, toUsd } = await import("./balances.js");

test("SayGM credits: the shapes a balance could come in", () => {
  assert.equal(readSaygmCredits({ balance: 12.5 }), 12.5);
  assert.equal(readSaygmCredits({ balance: "12.50" }), 12.5);
  assert.equal(readSaygmCredits({ balance_usd: 3 }), 3);
  assert.equal(readSaygmCredits({ balance_ndollars: 12_500_000_000 }), 12.5);
  assert.equal(readSaygmCredits({ balance_cents: 1250 }), 12.5);
  assert.equal(readSaygmCredits({ data: { balance: { usd: 7.25 } } }), 7.25);
  assert.equal(readSaygmCredits({ balance: { amount: "7.25", currency: "USD" } }), 7.25);
  assert.equal(readSaygmCredits({ credits: { remaining: 4 } }), 4);
  assert.equal(readSaygmCredits({ balance: 0 }), 0, "an empty balance is still a balance");
});

test("SayGM credits: nothing is guessed", () => {
  assert.equal(readSaygmCredits({ object: "credits" }), null);
  assert.equal(readSaygmCredits({ balance: "lots" }), null);
  assert.equal(readSaygmCredits({ rate_limit_remaining: 50, remaining_requests: 9, tokens_remaining: 1000 }), null, "requests and tokens are not money");
  assert.equal(readSaygmCredits(null), null);
  assert.equal(readSaygmCredits([{ balance: 5 }]), null);
  assert.equal(readSaygmCredits({ balance: Number.POSITIVE_INFINITY }), null);
});

test("Ditto usage: dollars spent and what is left under the cap; Ditto tokens are not dollars", () => {
  assert.deepEqual(readDittoUsage({ requests: 40, spendUsd: 1.75, spendCap: { limitUsd: 10, remainingUsd: 8.25 } }), { spent: 1.75, remaining: 8.25 });
  assert.deepEqual(readDittoUsage({ totals: { costUsd: 0.4, dittoTokens: 123456 }, cap: null }), { spent: 0.4 });
  assert.deepEqual(readDittoUsage({ usage: { spend: { tokens: 5000, usd: 0.9 } }, remaining_usd: "2" }), { spent: 0.9, remaining: 2 });
  assert.deepEqual(readDittoUsage({ spendTokens: 5000, days: [], models: [] }), {}, "only Ditto tokens: no dollar figure is made up");
  assert.deepEqual(readDittoUsage({}), {});
});

test("units come from the field's name", () => {
  assert.equal(toUsd(2_000_000_000, "balance_ndollars"), 2);
  assert.equal(toUsd(2_000_000, "balanceMicros"), 2);
  assert.equal(toUsd(200, "balance_cents"), 2);
  assert.equal(toUsd(2, "balance"), 2);
});
