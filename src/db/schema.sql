-- Jev Sniper Bot – SQLite séma (v1). Minden idő UTC ISO string vagy unix ms.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Felfedezett tokenek (2. lépés tölti)
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY,
  chain TEXT NOT NULL,                 -- base | robinhood
  address TEXT NOT NULL,
  creator TEXT,
  launchpad TEXT,                      -- clanker | zora | flaunch | hoodfun | uniswap | ...
  mechanics TEXT,                      -- bonding_curve | v2 | v3 | v4 | v4_hook
  pool_address TEXT,
  name TEXT, symbol TEXT,
  discovered_at INTEGER NOT NULL,
  discovered_block INTEGER,
  status TEXT NOT NULL DEFAULT 'new',  -- new | filtered | evaluated | entered | skipped
  filter_reason TEXT,
  pair_token TEXT,
  graduated_at INTEGER,
  bytecode_hash TEXT,
  graduation_threshold TEXT,           -- PONS: quote wei (stringként, bigint)
  pool_key_json TEXT,                  -- Uniswap v4 PoolKey {currency0,currency1,fee,tickSpacing,hooks}
  decimals INTEGER,                    -- ERC20 decimals (a gyűjtő tölti); az árfeed innen olvassa
  UNIQUE(chain, address)
);

-- Paraméter-pillanatképek (30/60/180 mp), méret korlátozva (config db.max_snapshot_bytes)
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  token_id INTEGER NOT NULL REFERENCES tokens(id),
  window_sec INTEGER NOT NULL,
  taken_at INTEGER NOT NULL,
  block_number INTEGER,
  price_native REAL, reserve_native REAL, reserve_token REAL,
  params_json TEXT NOT NULL,
  UNIQUE(token_id, window_sec)
);

-- Minden Jev-hívás naplója (kötegelt kérdések egy sorban), teljes valószínűségekkel
CREATE TABLE IF NOT EXISTS jev_calls (
  id INTEGER PRIMARY KEY,
  purpose TEXT NOT NULL,              -- entry | hold | regime | verify
  token_id INTEGER REFERENCES tokens(id),
  window_sec INTEGER,
  called_at INTEGER NOT NULL,
  block_number INTEGER,
  price_native REAL, reserve_native REAL, reserve_token REAL,
  model TEXT,
  input_tokens INTEGER, output_tokens INTEGER,
  cost_usd REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  ok INTEGER NOT NULL,                -- 1 siker, 0 hiba
  error TEXT,
  answers_json TEXT                   -- teljes válasz (minden valószínűség)
);

-- Kemény szűrőn kiesettek oka (tölcsér-riporthoz)
CREATE TABLE IF NOT EXISTS filter_log (
  id INTEGER PRIMARY KEY,
  token_id INTEGER NOT NULL REFERENCES tokens(id),
  at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT
);

-- Döntések: élő és árnyékkarok (arm) minden tokenre/ablakra
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY,
  token_id INTEGER NOT NULL REFERENCES tokens(id),
  arm TEXT NOT NULL,                  -- live | jev_direct_0.30 | rule_score | learned | random_control ...
  window_sec INTEGER NOT NULL,
  regime TEXT,
  decided_at INTEGER NOT NULL,
  enter INTEGER NOT NULL,             -- 1 belép, 0 nem
  reason TEXT,
  size_usd REAL,
  jev_call_id INTEGER REFERENCES jev_calls(id)
);

-- Pozíciók (élő és árnyék). Árnyéknál is minden mező kitöltve, költségmodellel.
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY,
  token_id INTEGER NOT NULL REFERENCES tokens(id),
  chain TEXT NOT NULL,
  arm TEXT NOT NULL,                  -- live | shadow-arm neve
  exit_plan TEXT NOT NULL DEFAULT 'live', -- live | B | C | moon10 | moon30 | trail40 | trail60
  window_sec INTEGER NOT NULL,
  opened_at INTEGER NOT NULL,
  entry_price_native REAL NOT NULL,
  size_usd REAL NOT NULL,
  size_native REAL NOT NULL,
  tokens_bought REAL NOT NULL,
  tokens_remaining REAL NOT NULL,
  phase TEXT NOT NULL DEFAULT 'pre_tp1',   -- pre_tp1 | post_tp1 | moon_bag | closed | unsellable
  peak_price_native REAL,
  closed_at INTEGER,
  close_reason TEXT,
  gross_pnl_usd REAL, fees_usd REAL, gas_usd REAL, jev_cost_usd REAL, net_pnl_usd REAL,
  stages_done INTEGER NOT NULL DEFAULT 0,
  native_received REAL NOT NULL DEFAULT 0,
  next_check_at INTEGER,
  creator_balance_at_entry REAL,
  liquidity_at_entry REAL,
  last_price_native REAL,             -- legutóbbi ellenőrzéskori ár (nyitott pozíció piaci értékeléséhez)
  last_price_at INTEGER,
  liq_rebased INTEGER NOT NULL DEFAULT 0, -- graduáció után a likviditás-alap a v4 poolra állítva
  UNIQUE(token_id, arm, exit_plan, window_sec)
);

-- Kitöltések (élő tx-ek és árnyék-fillek)
CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY,
  position_id INTEGER NOT NULL REFERENCES positions(id),
  chain TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- buy | approve | sell | sell_failed
  is_live INTEGER NOT NULL,
  at INTEGER NOT NULL,
  tx_hash TEXT,
  nonce INTEGER,
  block_number INTEGER,
  status TEXT NOT NULL,               -- pending | success | failed | simulated
  est_price_native REAL, real_price_native REAL,
  est_gas_usd REAL, real_gas_usd REAL,
  slippage_pct REAL, fee_usd REAL,
  amount_in REAL, amount_out REAL,
  error TEXT
);

-- Nonce-ok láncenként (újraindítás után visszaolvasva)
CREATE TABLE IF NOT EXISTS nonces (
  chain TEXT PRIMARY KEY,
  next_nonce INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Napi limitek és számlálók (UTC nap)
CREATE TABLE IF NOT EXISTS daily_state (
  day TEXT PRIMARY KEY,               -- YYYY-MM-DD
  entries INTEGER NOT NULL DEFAULT 0,
  realized_pnl_usd REAL NOT NULL DEFAULT 0,
  jev_cost_usd REAL NOT NULL DEFAULT 0,
  consecutive_failed_tx INTEGER NOT NULL DEFAULT 0,
  paused_reason TEXT
);

-- Compound-állapot (egyetlen sor, id=1)
CREATE TABLE IF NOT EXISTS compound_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  deposit_usd REAL NOT NULL,
  growth_pool_usd REAL NOT NULL DEFAULT 0,
  reserve_usd REAL NOT NULL DEFAULT 0,
  working_capital_peak_usd REAL NOT NULL,
  position_usd REAL NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS size_changes (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  old_position_usd REAL NOT NULL,
  new_position_usd REAL NOT NULL,
  growth_pool_usd REAL NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS regime_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  regime TEXT NOT NULL,               -- hot | normal | cold | risk_off
  source TEXT NOT NULL,               -- jev | hard_override
  inputs_json TEXT,
  jev_call_id INTEGER REFERENCES jev_calls(id)
);

-- Saját listák (12. lépés)
CREATE TABLE IF NOT EXISTS wallet_lists (
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  list TEXT NOT NULL,                 -- smart_money | scammer | insider | creator_good | creator_bad
  score REAL NOT NULL DEFAULT 0,
  occurrences INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(chain, address, list)
);

-- Címkézett tokenek 24 órás sorsa (tanuláshoz, kalibrációhoz): elérte-e előbb a 2x-et, mint a -40%-ot
CREATE TABLE IF NOT EXISTS token_outcomes (
  token_id INTEGER NOT NULL REFERENCES tokens(id),
  window_sec INTEGER NOT NULL,        -- melyik ablak árától mérünk (30/60/180)
  ref_price REAL NOT NULL,
  ref_at INTEGER NOT NULL,
  max_multiple REAL NOT NULL DEFAULT 1,
  min_multiple REAL NOT NULL DEFAULT 1,
  first_hit TEXT,                     -- tp1_first | stop_first | NULL
  hit_at INTEGER,
  done_at INTEGER,                    -- 24h után lezárva (neither_24h, ha first_hit NULL)
  PRIMARY KEY (token_id, window_sec)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- start | stop | panic | pause | resume | size_change | alert
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_tokens_status ON tokens(status);
CREATE INDEX IF NOT EXISTS idx_tokens_bytecode ON tokens(bytecode_hash);
CREATE INDEX IF NOT EXISTS idx_positions_open ON positions(phase) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_jev_calls_at ON jev_calls(called_at);
CREATE INDEX IF NOT EXISTS idx_decisions_token ON decisions(token_id, arm);

-- Árnyékkar-állapotok a futás közbeni figyelőhöz (Telegram-riasztás állapotváltáskor)
CREATE TABLE IF NOT EXISTS arm_states (
  key TEXT PRIMARY KEY,               -- arm|window_sec|exit_plan
  state TEXT NOT NULL,                -- none | promising | candidate
  n INTEGER, mean REAL, ci_lo REAL, ci_hi REAL,
  updated_at INTEGER NOT NULL
);

-- Copy trading: a követett tokenek összes vétele/eladása tárcánként (PONS curve-események, v4 Swap + Transfer párosítva)
CREATE TABLE IF NOT EXISTS wallet_trades (
  id INTEGER PRIMARY KEY,
  chain TEXT NOT NULL,
  token_id INTEGER NOT NULL REFERENCES tokens(id),
  wallet TEXT NOT NULL,
  is_buy INTEGER NOT NULL,
  native REAL NOT NULL,               -- ETH (a tárca szemszögéből: vételnél kiadott, eladásnál kapott)
  tokens REAL NOT NULL,
  block INTEGER NOT NULL,
  at INTEGER NOT NULL,                -- észlelés ideje (ms)
  tx_hash TEXT NOT NULL,
  UNIQUE(tx_hash, token_id, wallet, is_buy)
);
CREATE INDEX IF NOT EXISTS idx_wallet_trades_wallet ON wallet_trades(chain, wallet);
CREATE INDEX IF NOT EXISTS idx_wallet_trades_token ON wallet_trades(token_id);

-- Listázás-figyelő: már látott tételek (első futáskor alapállapot, esemény nélkül), események, ár-minták
CREATE TABLE IF NOT EXISTS listing_seen (
  source TEXT NOT NULL,               -- coinbase_currency | coinbase_product | robinhood_pair
  key TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  PRIMARY KEY (source, key)
);
CREATE TABLE IF NOT EXISTS listing_events (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,               -- coinbase | robinhood
  kind TEXT NOT NULL,                 -- currency_added | trading_live | rh_tradable
  symbol TEXT NOT NULL,
  chain TEXT,                         -- base | robinhood (ha feloldható)
  address TEXT,
  detected_at INTEGER NOT NULL,
  entry_price_usd REAL,
  entry_liq_usd REAL,
  dex_id TEXT,
  note TEXT,
  UNIQUE(source, kind, symbol)
);
CREATE TABLE IF NOT EXISTS listing_prices (
  event_id INTEGER NOT NULL REFERENCES listing_events(id),
  at INTEGER NOT NULL,
  price_usd REAL NOT NULL,
  liq_usd REAL,
  PRIMARY KEY (event_id, at)
);

-- BNB Chain / Four.Meme felvevő (2026-10-04): a TokenManager2 nyers eseményei. A nagy számok (wei, token-mennyiség) szövegként.
CREATE TABLE IF NOT EXISTS bnb_tokens (
  address TEXT PRIMARY KEY,           -- kisbetűs
  creator TEXT, name TEXT, symbol TEXT,
  total_supply TEXT, launch_time INTEGER, launch_fee TEXT, request_id TEXT,
  created_block INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bnb_trades (
  tx TEXT NOT NULL, log_index INTEGER NOT NULL,
  token TEXT NOT NULL, block INTEGER NOT NULL, at INTEGER NOT NULL,   -- at: becsült ms (blokkszám pontos)
  side TEXT NOT NULL,                 -- buy | sell
  account TEXT NOT NULL,              -- vételnél a token címzettje, eladásnál az eladó
  price TEXT NOT NULL,                -- lastPrice a kötés UTÁN (quote wei / token, 1e18 skála)
  amount TEXT NOT NULL, cost TEXT NOT NULL, fee TEXT NOT NULL,
  offers TEXT NOT NULL,               -- maradék görbe-készlet a kötés után
  funds TEXT NOT NULL,                -- összegyűlt quote a kötés után (görbe-haladás = funds / maxFunds)
  PRIMARY KEY (tx, log_index)
);
CREATE INDEX IF NOT EXISTS idx_bnb_trades_token ON bnb_trades(token, block);
CREATE TABLE IF NOT EXISTS bnb_grads (
  token TEXT NOT NULL, block INTEGER NOT NULL, at INTEGER NOT NULL, tx TEXT,
  kind TEXT NOT NULL,                 -- trade_stop | liquidity_added (graduáció → PancakeSwap)
  quote TEXT, lp_tokens TEXT, funds TEXT,
  PRIMARY KEY (token, kind)
);
