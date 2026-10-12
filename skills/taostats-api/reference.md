# Taostats /api → /v1 reference

From https://taostats.io/blog/api-migration-guide.md (2026-10-08). Old `/api/` routes switch off **9 November 2026**.
Status: **R** replaced, **P** partly replaced, **N** no replacement. GET unless noted.

## Exceptions to the general rules

- TradingView, CoinGecko, CoinMarketCap routes keep legacy formats (no `data`/`pagination`), ignore unknown params. TradingView history: up to 5,000 bars; `7D` bars start Thursdays, `30D` are fixed 30-day periods.
- `/v1/alpha/portfolio`: no paging (`page`/`limit` → 400). `/v1/validators/active`: no paging.
- `/v1/miners/coldkey-summary`: no `limit`; `days` max 36,500.
- `/v1/subnets/distribution/*`: only `netuid`; whole list returned.
- `POST /v1/validators/yield`: `order_by`/`order_dir` in the JSON body; max `limit` 200 (was 1,000).
- `/v1/alpha/hotkey-shares`: no sort params (alpha desc). `/v1/subnets/hyperparameters`: no sort.
- `/v1/evm/blocks|contracts|logs|transactions`, `/v1/contract-events`: `limit` > 200 is clamped (not 400); timestamps without ms.
- `/v1/historic/stake-events`: no `netuid`, `is_transfer`, `transfer_address`, `amount_min`, `amount_max`.
- `/v1/tax/report`: whole report on one page.

## Field changes

- `is_immunity_period`→`is_immune`; `registration_block`→`registered_at_block`; `total_tao`→`tao_in_pool`
- `fear_and_greed_index`→`sentiment_index`; `fear_and_greed_sentiment`→`sentiment`
- `pruning_rank`→`rank`; `v_trust`→`vtrust`; `type`→`validator_type`; `call_args`→`args`
- `full_name` removed (use `pallet` + `name`); `extrinsic_index` removed (number after the dash in `extrinsic_id`)
- `tao_volume_one_day`→`tao_volume_24_hr`; `blocks_since_last_step`→`blocks_since_last_epoch`
- `recycled_24_hours`→`tao_from_neuron_registration_24_hours` (metrics)
- `subtoken_enabled`→`subnet_is_active`; `transfer_toggle`→`transfers_enabled`
- `mech_count`→`mechanism_count`; `mech_emission_split`→`mechanism_emission_split` (raw /65,535)
- `max_neurons`→`max_allowed_uids`; `max_validators`→`max_allowed_validators`; `max_regs_per_block`→`max_registrations_per_block`
- `bonds_moving_avg`→`bonds_moving_average` (fraction, string); `bonds_reset_on`→`bonds_reset_enabled`
- `immune_owner_uids_limit`→`owner_immune_neuron_limit`; `yuma3_on`→`yuma_version` (2|3)
- `commit_reveal_weights_interval` + `reveal_period_epochs`→`commit_reveal_period`
- `blocks_since_weights_set`→`updated`
- subnet emission: `tao_in_pool`→`tao_in_emission`, `alpha_in_pool`→`alpha_in_emission`, `alpha_rewards`→`alpha_out_emission`
- extrinsics `signature` is hex; `signer_address` and calls' `origin_address` are SS58; events `call_id` now filled
- `neuron_registration_cost` removed from neuron-registration-events (sum `registration_cost`)
- `axon` is `"ip:port"`; metagraph has no `daily_reward`, `rank`, `trust`, `stake`, `collateral`
- removed: `balance_liquidity(_24hr_ago)` (accounts), `claim_types` (validators), `stake`/`family_stake` (hotkey family); subnet identity `summary`/`tags`/`twitter` always null
- `proportion_staked` now populated; `kappa` is a fraction of 65,535; `difficulty`/`min_difficulty`/`max_difficulty`/`adjustment_alpha` are 64-bit integers as strings; `bonds_penalty` now the chain value
- `pending_coldkey_swap` adds `disputed`, `disputed_block_number`; `root_claim` adds `tao` (RAO; null before block 8,765,684); `status` adds `timestamp`
- incentive distribution `incentive` has 10 decimals; buy trades' `tao_value` = TAO actually spent

## Data coverage

dTAO starts at block 4,920,351. Pool history from 2025-02-13 (block 4,921,036); subnet history from 2025-02-14 (block 4,924,800); registration-cost and metagraph history from 2025-02-13. `/v1/subnets/metagraph/history` is one row per epoch (was per day). From block 6,067,944, total-price history counts volume differently and stake-events `trades_only` excludes same-subnet moves. Subnet history `by_day` uses blocks divisible by 7,200 (~10:02 UTC); daily alpha snapshots are stamped 23:59:48.

## Route map

**Accounts and tax**
- `/api/account/latest/v1` → R `/v1/accounts/{address}`, `/v1/accounts/leaderboard`
- `/api/account/history/v1` → R `/v1/accounts/{address}/history`
- `/api/accounting/tax/v1` → R `/v1/tax/report`; `tax_csv` → `/v1/tax/report?format=csv`; `tax_token` → `/v1/tax/active-tokens`
- `/api/accounting/coldkey_report/v1`, `coldkey_report_csv/v1` → N
- `/api/accounting/v1` → P `/v1/subnets/neuron-registration-events`

**Blocks, calls, events, transfers**
- `/api/block/v1` → `/v1/blocks`; `/api/block/emission/v1` → `/v1/tokenomics/emission`; `/api/block/interval/v1` → P `/v1/subnets/pools/total-price/history`
- `/api/call/v1` → `/v1/calls`; `/api/event/v1` → `/v1/events`; `/api/extrinsic/v1` → `/v1/extrinsics`; `/api/proxy_call/v1` → `/v1/proxy-calls`; `/api/transfer/v1` → `/v1/transfers`

**EVM and contracts**
- `/api/evm/address_from_ss58/v1` → `/v1/evm/address_from_ss58` (also `/v1/evm/conversions/ss58-to-address`)
- `/api/evm/block/v1` → `/v1/evm/blocks`; `contract` → `/v1/evm/contracts`; `log` → `/v1/evm/logs`; `transaction` → `/v1/evm/transactions`
- `/api/evm/erc20/token/v1` → P `/v1/evm/contracts`; `erc20/transfer/v1` → P `/v1/evm/logs?event_name=Transfer&address=<token>`; `erc20/account/v1` → N
- `/api/contract_event/v1` → `/v1/contract-events`; `/api/contract_event/{id}/v1` → `/v1/contract-events?id={id}`

**Network, runtime, misc**
- `/api/runtime_version/latest/v1` → `/v1/network/runtime-version`; `history` → `/v1/network/runtime-version/history`
- `/api/pending_coldkey_swap/v1` → `/v1/accounts/pending-coldkey-swaps`; `/api/root_claim/v1` → `/v1/alpha/root-claims`
- `/api/exchange/v1` → `/v1/exchange-addresses`; `/api/status/v1` → `/v1/status`
- `POST /api/v1/rpc/http` → P `POST /v1/rpc/http` (raw JSON-RPC or batch; always `finney_lite`)
- `GET /api/v1/rpc/ws/{target}` → `WS /v1/rpc/ws/{target}` (`wss://`; `finney_lite` | `finney_archive`)
- `POST /api/seal_blob/v1` → N

**Subnets**
- `/api/subnet/latest/v1` → P `/v1/subnets/metrics` + `/v1/subnets/hyperparameters`; `history` → `/v1/subnets/history`
- `identity` → `/v1/subnets/identities`; `identity_set` → `/v1/subnets/identities/history`; `metadata` → N; `owner` → `/v1/subnets/owners`
- `registration` → `/v1/subnets/registrations`; `registration_cost/latest` → `/v1/subnets/registration-cost`; `registration_cost/history` → `/v1/subnets/registration-cost/history`
- `neuron/registration` → `/v1/subnets/neuron-registration-events`; `neuron/deregistration` → `/v1/subnets/neuron-deregistration-events`
- `distribution/coldkey|incentive|ip` → `/v1/subnets/distribution/coldkey|incentive|ip`
- `pruning/latest` → `/v1/subnets/deregistrations`; `pruning/history` → `/v1/subnets/deregistrations/history`

**Pools and liquidity**
- `/api/dtao/pool/latest/v1`, `/api/dtao/pool/v1` → `/v1/subnets/pools`, `/v1/subnets/pools/aggregate`; `pool/history` → `/v1/subnets/pools/history`
- `pool/total_price/latest` → `/v1/subnets/pools/total-price`; `total_price/history` and `total_price/v1` → `/v1/subnets/pools/total-price/history`
- `/api/dtao/liquidity/distribution|position|position/history|position_event|tick_to_price` → N

**Metagraph and neurons**
- `/api/metagraph/latest/v1`, `/api/neuron/latest/v1` → `/v1/subnets/metagraph`; `metagraph/history`, `neuron/history` → `/v1/subnets/metagraph/history`
- `/api/metagraph/root/latest|history` → N
- `/api/neuron/aggregated/latest` → `/v1/subnets/metagraph/aggregate`; `aggregated/history` → `/v1/subnets/metagraph/aggregate/history`
- `/api/neuron/incentive_distribution/v1` → `/v1/subnets/metagraph/history?has_incentive=true`

**Validators**
- `/api/dtao/validator/latest/v1` → `/v1/validators`; `history` → `/v1/validators/{hotkey}/history`; `available` → `/v1/validators/active`
- `basket/latest` → `/v1/validators/baskets`; `basket/history` → `/v1/validators/baskets/history`; `dividends/*` → N
- `performance/latest` → `/v1/validators/performance/{hotkey}`; `performance/history` → `/v1/validators/performance/{hotkey}/history`
- `GET|POST yield/latest` → `GET|POST /v1/validators/yield`; `yield/history` → N
- `/api/validator/latest/v1` → N; `/api/validator/history/v1` → P `/v1/validators/{hotkey}/history/pre-dtao`; `identity` → N
- `/api/validator/metrics/latest` → P `/v1/subnets/metagraph?netuid=&hotkey=`; `metrics/history` → P `/v1/subnets/metagraph/history`; `performance/v1` → P `/v1/subnets/metagraph/history?netuid=&uid=`; `weight_copier` → N
- `/api/validator/weights/latest|history/v2` → `/v1/validators/weights` | `/v1/validators/weights/history` (v1 routes: P, same targets)
- `/api/hotkey/family/latest` → `/v1/validators/hotkey-family`; `history` → `/v1/validators/hotkey-family/history`

**Delegation, stake, identity**
- `/api/delegation/v1` → `/v1/subnets/stake-events` (dTAO) + `/v1/historic/stake-events` (earlier)
- `/api/stake/v1`, `/api/stake_balance/history/v1` → N
- `/api/identity/latest/v1` → `/v1/accounts/identities`, `/v1/accounts/{address}/identity`; `identity/history` → N

**Miners and conviction**
- `/api/miner/autostake/v1` → `/v1/miners/autostakes`; `miner/coldkey` → `/v1/miners/coldkey-summary`
- `miner/weights/latest` → `/v1/miners/weights`; `history` → `/v1/miners/weights/history`
- `/api/conviction/latest/v1` → `/v1/subnets/conviction`; `history` → `/v1/subnets/conviction/history`

**Alpha positions, trades, burns, emission**
- `/api/dtao/stake_balance/latest` → `/v1/alpha/leaderboard`; `history` → `/v1/alpha/history`; `portfolio` → `/v1/alpha/portfolio`
- `stake_balance_aggregated/latest` → P `/v1/accounts/leaderboard`, `/v1/accounts/{address}`
- `hotkey_alpha_shares/latest` → `/v1/alpha/hotkey-shares`; `hotkey_alpha_shares/history` → N
- `coldkey_alpha_shares/latest` → P `/v1/alpha/leaderboard`; `history` → P `/v1/alpha/history`
- `/api/dtao/trade/v1` → `/v1/subnets/trades`; `burned_alpha` → P `/v1/subnets/burns` (no incentive burns); `burned_alpha/total` → `/v1/subnets/burns/total`
- `subnet_emission` → `/v1/subnets/epochs`; `hotkey_emission`, `tao_flow`, `delegation_volume`, `slippage` → N

**Prices, stats, feeds**
- `/api/price/latest/v1` → `/v1/price`; `price/simple/latest` → `/v1/price/simple`; `price/history` → `/v1/price/history`; `price/ohlc` → `/v1/price/ohlc`
- `/api/stats/latest/v1` → `/v1/network/stats`; `stats/history` → `/v1/network/stats/history`; `/api/network_parameter/latest/v1` → `/v1/network/parameters`
- `/api/dtao/tradingview/udf/config|symbol_info|history` → `/v1/tradingview/udf/config|symbol_info|history`
- `/api/coingecko/latest-block|asset|pair|events` → `/v1/coingecko/...` (same names)
- `/api/dev_activity/latest|history`, `/api/dev_changelog` → N

**OTC**
- v1 contract: `/api/otc/listing|offer|trade|user/stats|subnet/status/v1` → `/v1/otc/contract-v1/listings|offers|trades|users/stats|subnets/status` (+ `/history` for listings and offers)
- v2: `/api/otc/listing|offer|trade|user/stats|subnet/status/v2` → `/v1/otc/listings|offers|trades|users/stats|subnets/status` (+ `/history`)
- lockup: `/api/otc/lockup/listing|purchase|claim|user/stats/v1` → `/v1/otc/lockup/listings|purchases|claims|users/stats` (+ `listings/history`)

**Live (`/api/v1/live/...`)**
- `blocks/head` → P `/v1/blocks?limit=1`; `blocks/{h}` → P `/v1/blocks?block_start={h}&block_end={h}`; `blocks` → P `/v1/blocks?block_start=&block_end=`
- `blocks/{h}/extrinsics/{i}` → P `/v1/extrinsics?id={h}-{i}&include_args=true` + `/v1/events?extrinsic_id={h}-{i}`
- `accounts/{address}/balance-info` → P `/v1/accounts/{address}`
- `extrinsics-raw`, `node/transaction-pool`, `node/version`, `pallets/*` → N
