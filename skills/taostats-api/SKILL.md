---
name: taostats-api
description: Use for any Taostats API call or code that calls it (Bittensor/TAO prices, subnets, pools, validators, stake, accounts, metagraph). Uses the new /v1 API; the old /api/ routes switch off on 9 November 2026.
---

# Taostats API (v1)

Source: https://taostats.io/blog/api-migration-guide.md (published 2026-10-08). The full old → new route table is in [reference.md](reference.md).

## Rules

- **Host** `https://api.taostats.io`. **Paths start with `/v1/`.** Never write new code against `/api/...`; it stops responding on **9 November 2026**. When you find `/api/` calls in existing code, migrate them with reference.md.
- **Auth**: header `Authorization: $TAOSTATS_API_KEY` — the raw key, **no `Bearer`**. Same key for old and new APIs. Never print or commit the key.
- **User-Agent**: Python `urllib` gets 403 with its default UA; set one (`bitbob-agent/1.0`). `requests`, `curl`, `fetch` are fine.
- **Network** param: `finney` (default), `nakamoto`, `kusanagi`. `testnet` → 400.

## Requests

- **Paging**: default `limit` 50, **max 200** (higher → 400). Response is `{ "pagination": {current_page, per_page, total_items, total_pages, next_page, prev_page}, "data": [...] }`. Loop `page` from 1 until `pagination.next_page` is null. The window ends at `(page-1)×limit` = 1,000,000; narrow with `block_start`/`block_end` or `timestamp_start`/`timestamp_end` instead of paging deep.
- **Sorting**: `order_by=<column>&order_dir=asc|desc` (old `order=amount_desc` is gone). Columns differ per endpoint; unknown ones → 400.
- **Unknown parameters → 400** (the message lists the valid ones). Read it and fix the call; don't retry blindly.
- **Filters**:
  - `block_number` removed → `block_start` = `block_end` = N.
  - `date_*` / `day_*` → `timestamp_start` / `timestamp_end` (Unix seconds).
  - `nominator` → `coldkey`, `delegate` → `hotkey`, `delegate_name` → `hotkey_name`.
  - action values `delegate`/`undelegate` → `stake`/`unstake`.
  - amount filters (`amount_min`, `balance_free_min`, …) are whole numbers in **RAO**.
  - Some routes take the address in the path: `/v1/accounts/{address}`, `/v1/validators/{hotkey}/history`.
  - Combined netuids ≥ 4096 → `netuid` + `mechanism` (old 4140 = `netuid=44&mechanism=1`).

## Responses

- **Big numbers are strings, mostly RAO** (1 TAO = 10⁹ RAO). Parse with `Decimal` (Python) or `BigInt` (JS); never `float`/`Number` for balances.
- SS58 addresses are plain strings (no `{ss58, hex}` objects). Timestamps are ISO 8601 UTC **with milliseconds** (`…:36.000Z`; EVM routes have none).
- Single-item routes (e.g. `/v1/network/stats`) return `{ "data": {…} }` with no pagination. `/v1/accounts/{address}` returns a one-element list; `/v1/price` and `/v1/price/simple` still return a one-row list with pagination.
- Call/event/extrinsic `args`: snake_case keys, accounts as `{"Id":"5…"}`, enums as variant names, options `"None"` / `{"Some": v}`.
- Common field renames: `total_tao`→`tao_in_pool`, `is_immunity_period`→`is_immune`, `registration_block`→`registered_at_block`, `v_trust`→`vtrust`, `type`→`validator_type`, `call_args`→`args`, `tao_volume_one_day`→`tao_volume_24_hr`, `fear_and_greed_index`→`sentiment_index`, `max_neurons`→`max_allowed_uids`. Full list in reference.md.

## Most-used routes

| Need | Route |
|---|---|
| TAO price | `/v1/price`, `/v1/price/history`, `/v1/price/ohlc` |
| Network stats | `/v1/network/stats` |
| Account balance | `/v1/accounts/{address}` (history: `/history`) |
| Subnet pools / alpha price | `/v1/subnets/pools`, `/v1/subnets/pools/history` |
| Subnet metrics + hyperparameters | `/v1/subnets/metrics`, `/v1/subnets/hyperparameters` |
| Metagraph | `/v1/subnets/metagraph?netuid=` (history: `/history`, one row per epoch) |
| Validators / yield | `/v1/validators`, `/v1/validators/{hotkey}/history`, `GET`/`POST /v1/validators/yield` |
| Stake / unstake events | `/v1/subnets/stake-events` (dTAO, from block 4,920,351), `/v1/historic/stake-events` (before) |
| Alpha positions | `/v1/alpha/portfolio` (no paging), `/v1/alpha/leaderboard`, `/v1/alpha/history` |
| Trades | `/v1/subnets/trades` |
| Conviction | `/v1/subnets/conviction` (history: `/history`) |
| Tax report | `/v1/tax/report` (`?format=csv`) |

## Example

```bash
curl -s -H "Authorization: $TAOSTATS_API_KEY" \
  "https://api.taostats.io/v1/transfers?order_by=amount&order_dir=desc&limit=10"
```

```python
import os, requests
from decimal import Decimal
H = {"Authorization": os.environ["TAOSTATS_API_KEY"], "User-Agent": "bitbob-agent/1.0"}
def fetch_all(path, **params):
    params.setdefault("limit", 200); page = 1
    while page:
        r = requests.get(f"https://api.taostats.io{path}", headers=H, params={**params, "page": page}, timeout=30)
        r.raise_for_status(); body = r.json()
        yield from body["data"]
        page = body["pagination"]["next_page"]
tao = lambda rao: Decimal(rao) / Decimal(10**9)
```

Some routes have no replacement (e.g. `/api/stake/v1`, liquidity positions, `dev_activity`, hotkey emission, slippage). Check reference.md and tell the user when a figure can't be fetched any more rather than guessing.
