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
-- 2026-10-06: karonkénti lekérdezések (HUD, /allas, riport) a 750 ezres táblán
CREATE INDEX IF NOT EXISTS idx_positions_arm ON positions(arm, window_sec, exit_plan, chain, opened_at);
CREATE INDEX IF NOT EXISTS idx_positions_plan_opened ON positions(exit_plan, opened_at);
CREATE INDEX IF NOT EXISTS idx_fills_position ON fills(position_id, kind);
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

-- Solana / Pump.fun felvevő (2026-10-04). Árak SOL/token; összegek SOL (szám); idők ms (a láncon rögzített unix mp-ből).
CREATE TABLE IF NOT EXISTS sol_tokens (
  mint TEXT PRIMARY KEY, symbol TEXT, name TEXT, creator TEXT, user TEXT, created_at INTEGER NOT NULL,
  quote_sol INTEGER NOT NULL, quote_mint TEXT, mayhem INTEGER, holder_reward INTEGER, creator_fee_bps INTEGER, bonding_curve TEXT
);
CREATE TABLE IF NOT EXISTS sol_trades (
  id INTEGER PRIMARY KEY, mint TEXT NOT NULL, at INTEGER NOT NULL, side TEXT NOT NULL, user TEXT NOT NULL,
  sol REAL NOT NULL, tokens REAL NOT NULL, price REAL NOT NULL, progress_pct REAL NOT NULL, signature TEXT
);
CREATE INDEX IF NOT EXISTS idx_sol_trades_mint ON sol_trades(mint, at);
CREATE TABLE IF NOT EXISTS sol_snapshots (
  mint TEXT NOT NULL, window_sec INTEGER NOT NULL, at INTEGER NOT NULL,
  buys INTEGER, sells INTEGER, unique_buyers INTEGER, sol_in REAL, sol_out REAL, largest_buy_sol REAL,
  price REAL, progress_pct REAL, creator_sold INTEGER, creator_bought INTEGER, last_trade_age_sec INTEGER,
  PRIMARY KEY (mint, window_sec)
);
CREATE TABLE IF NOT EXISTS sol_outcomes (
  mint TEXT PRIMARY KEY, ref_price REAL NOT NULL, ref_at INTEGER NOT NULL, max_x REAL NOT NULL, min_x REAL NOT NULL,
  complete_at INTEGER, migrated_at INTEGER, done_at INTEGER,
  ref30_price REAL, max_x30 REAL, min_x30 REAL     -- a 30 perces árhoz mért csúcs/mélypont (túlélők, 2026-10-05)
);
CREATE TABLE IF NOT EXISTS sol_grads (mint TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, pool TEXT, quote_mint TEXT, PRIMARY KEY (mint, kind));

-- BNB Chain / PancakeSwap v2 felvevő (2026-10-04): közvetlen WBNB-pár indítások. Ár = WBNB-tartalék / token-tartalék (nyers arány, csak szorzóként).
CREATE TABLE IF NOT EXISTS bnb_pairs (
  pair TEXT PRIMARY KEY, token TEXT NOT NULL, wbnb_is0 INTEGER NOT NULL, created_block INTEGER NOT NULL, created_at INTEGER NOT NULL,
  creator TEXT, tx_to TEXT,           -- a likviditás-betétel (indítás) tx küldője és címzettje (router / indítóplatform)
  pair_created_block INTEGER           -- a PairCreated blokkja (a pár „héjként” ennyivel korábban jött létre)
);
CREATE TABLE IF NOT EXISTS bnb_pair_trades (
  pair TEXT NOT NULL, tx TEXT NOT NULL, log_index INTEGER NOT NULL, block INTEGER NOT NULL, at INTEGER NOT NULL,
  side TEXT NOT NULL, to_addr TEXT, bnb REAL NOT NULL, price REAL NOT NULL,
  PRIMARY KEY (tx, log_index)
);
CREATE INDEX IF NOT EXISTS idx_bnb_pair_trades_pair ON bnb_pair_trades(pair, at);
CREATE TABLE IF NOT EXISTS bnb_pair_snapshots (
  pair TEXT NOT NULL, window_sec INTEGER NOT NULL, at INTEGER NOT NULL,
  buys INTEGER, sells INTEGER, unique_buyers INTEGER, bnb_in REAL, bnb_out REAL, price REAL, liq_bnb REAL,
  PRIMARY KEY (pair, window_sec)
);
CREATE TABLE IF NOT EXISTS bnb_pair_outcomes (
  pair TEXT PRIMARY KEY, ref_price REAL NOT NULL, ref_at INTEGER NOT NULL, max_x REAL NOT NULL, min_x REAL NOT NULL,
  min_liq_bnb REAL, peak_liq_bnb REAL, done_at INTEGER
);

-- HUD beléptetés (2026-10-04): munkamenetek (csak a süti SHA-256 lenyomata) és passkey-k (WebAuthn nyilvános kulcsok).
CREATE TABLE IF NOT EXISTS hud_sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, method TEXT, ip TEXT);
CREATE TABLE IF NOT EXISTS hud_passkeys (id TEXT PRIMARY KEY, public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT, label TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER);

-- Solana / PumpSwap (graduáció utáni AMM) felvevő (2026-10-05): a pump_amm program CreatePool/Buy/Sell eseményei. Ár = quote-tartalék / base-tartalék (SOL/token).
CREATE TABLE IF NOT EXISTS sol_amm_pools (
  pool TEXT PRIMARY KEY, base_mint TEXT NOT NULL, quote_mint TEXT NOT NULL, quote_sol INTEGER NOT NULL, creator TEXT, coin_creator TEXT,
  created_at INTEGER NOT NULL, init_quote REAL, init_base REAL, mayhem INTEGER
);
CREATE TABLE IF NOT EXISTS sol_amm_trades (
  id INTEGER PRIMARY KEY, pool TEXT NOT NULL, at INTEGER NOT NULL, side TEXT NOT NULL, user TEXT NOT NULL,
  quote_sol REAL NOT NULL, base_amount REAL NOT NULL, price REAL NOT NULL, pool_quote REAL NOT NULL, signature TEXT
);
CREATE INDEX IF NOT EXISTS idx_sol_amm_trades_pool ON sol_amm_trades(pool, at);
CREATE TABLE IF NOT EXISTS sol_amm_snapshots (
  pool TEXT NOT NULL, window_sec INTEGER NOT NULL, at INTEGER NOT NULL,
  buys INTEGER, sells INTEGER, unique_buyers INTEGER, quote_in REAL, quote_out REAL, price REAL, pool_quote REAL, last_trade_age_sec INTEGER,
  PRIMARY KEY (pool, window_sec)
);
CREATE TABLE IF NOT EXISTS sol_amm_outcomes (
  pool TEXT PRIMARY KEY, ref_price REAL NOT NULL, ref_at INTEGER NOT NULL, max_x REAL NOT NULL, min_x REAL NOT NULL, min_pool_quote REAL, done_at INTEGER
);

-- 2026-10-07: BNB / PancakeSwap árnyékkarok (bnb_all60, bnb_whale) – saját tábla (a positions tábla a tokens-hez kötött, Base/Robinhood)
CREATE TABLE IF NOT EXISTS bnb_shadow_positions (
  id INTEGER PRIMARY KEY,
  pair TEXT NOT NULL, token TEXT NOT NULL, arm TEXT NOT NULL, plan TEXT NOT NULL,
  signal_at INTEGER NOT NULL, opened_at INTEGER NOT NULL, entry_price REAL NOT NULL, size_usd REAL NOT NULL, size_bnb REAL NOT NULL,
  tokens REAL NOT NULL, tokens_left REAL NOT NULL, received_bnb REAL NOT NULL DEFAULT 0, txs INTEGER NOT NULL DEFAULT 1,
  liq_at_entry REAL, phase TEXT NOT NULL DEFAULT 'open', peak_price REAL, last_price REAL, last_at INTEGER,
  closed_at INTEGER, close_reason TEXT, net_usd REAL,
  UNIQUE(pair, arm, plan)
);
CREATE INDEX IF NOT EXISTS idx_bnb_shadow_open ON bnb_shadow_positions(closed_at);
-- jelzések, amelyeknél NEM nyílt pozíció (honeypot-próba, hiba) – a szűrés hatásának méréséhez
CREATE TABLE IF NOT EXISTS bnb_shadow_skips (pair TEXT NOT NULL, arm TEXT NOT NULL, at INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY (pair, arm));

-- 2026-10-07: BNB / PancakeSwap ÉLŐ pozíciók és tranzakciók (külön a positions-tól: ott a token a tokens táblához kötött)
CREATE TABLE IF NOT EXISTS bnb_live_positions (
  id INTEGER PRIMARY KEY,
  pair TEXT NOT NULL, token TEXT NOT NULL, arm TEXT NOT NULL,
  signal_at INTEGER NOT NULL, opened_at INTEGER NOT NULL,
  spent_bnb REAL NOT NULL, spent_usd REAL NOT NULL, tokens REAL NOT NULL, tokens_left REAL NOT NULL,
  entry_price REAL NOT NULL, quoted_price REAL, liq_at_entry REAL, approved INTEGER NOT NULL DEFAULT 0,
  received_bnb REAL NOT NULL DEFAULT 0, gas_bnb REAL NOT NULL DEFAULT 0, peak_price REAL, last_price REAL,
  phase TEXT NOT NULL DEFAULT 'open', closed_at INTEGER, close_reason TEXT, net_usd REAL, sell_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bnb_live_fills (
  id INTEGER PRIMARY KEY,
  position_id INTEGER REFERENCES bnb_live_positions(id),
  kind TEXT NOT NULL, at INTEGER NOT NULL, tx_hash TEXT, status TEXT NOT NULL, gas_bnb REAL, bnb REAL, tokens REAL, price REAL, latency_ms INTEGER, error TEXT
);

-- 2026-10-08: BNB élő láb visszaforgatási állapota (a felhasználó szabálya: nyereség 30%-a a tőkéhez, veszteség 100%-ban; a méret arányos)
CREATE TABLE IF NOT EXISTS bnb_compound_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  initial_capital_usd REAL NOT NULL, capital_usd REAL NOT NULL, reserve_usd REAL NOT NULL DEFAULT 0,
  position_usd REAL NOT NULL, last_recalc_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

-- 2026-10-08: vétel+eladás szimuláció minden BNB-jelzésnél (honeypot-mérés; src/bnb/simtrade.ts). stage 5 = siker, 4 = eladás bukott.
CREATE TABLE IF NOT EXISTS bnb_sim_checks (
  pair TEXT NOT NULL, arm TEXT NOT NULL, at INTEGER NOT NULL, token TEXT NOT NULL,
  me_hi_stage INTEGER, me_hi_ratio REAL, me_lo_stage INTEGER, me_lo_ratio REAL, fresh_stage INTEGER, fresh_ratio REAL, ms INTEGER, error TEXT,
  PRIMARY KEY (pair, arm)
);

-- 2026-10-08: Base honeypot-teszt (v4 vétel+eladás szimuláció az élő útvonalon; src/exec/simV4.ts) – a 60 mp-es döntéskor, ha volt belépés
CREATE TABLE IF NOT EXISTS base_sim_checks (
  token_id INTEGER PRIMARY KEY REFERENCES tokens(id), at INTEGER NOT NULL,
  me_stage INTEGER, me_ratio REAL, fresh_stage INTEGER, fresh_ratio REAL, ms INTEGER, error TEXT
);
