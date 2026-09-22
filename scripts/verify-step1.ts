/**
 * 1. lépés verify: config + env + DB + kötegelt Jev-hívás + Telegram-üzenet.
 * Futtatás: npm run verify:step1
 * A privát kulcs itt NEM kötelező (a bot indításához igen).
 */
import { loadConfig } from "../src/config.js";
import { loadEnv } from "../src/env.js";
import { openDb } from "../src/db/index.js";
import { JevClient } from "../src/jev/client.js";
import { entryQuestions, smokeQuestions, scoreTo100 } from "../src/jev/questions.js";
import { Telegram } from "../src/telegram.js";
import { publicClient } from "../src/chains/index.js";

const ok = (m: string) => console.log("✅", m);
const bad = (m: string) => { console.log("❌", m); process.exitCode = 1; };

const cfg = loadConfig();
ok(`config.yaml betöltve (mode=${cfg.mode}, base_position=${cfg.risk.base_position_usd} USD, max_open=${cfg.risk.max_open_positions})`);

let env;
try { env = loadEnv({ requireWallet: false }); ok(".env betöltve (kulcsok jelen vannak, nincs kiírva)"); }
catch (e) { bad((e as Error).message); process.exit(1); }

const db = openDb(":memory:");
const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
ok(`DB séma létrejött: ${tables.length} tábla (${tables.join(", ")})`);

for (const [key, url] of [["base", env.BASE_RPC_URL], ["robinhood", env.ROBINHOOD_RPC_URL]] as const) {
  try {
    const c = publicClient(key, url);
    const id = await c.getChainId();
    const bn = await c.getBlockNumber();
    if (id !== cfg.chains[key].chain_id) bad(`${key} RPC chain id ${id} ≠ config ${cfg.chains[key].chain_id}`);
    else ok(`${key} RPC ok: chain ${id}, blokk ${bn}`);
  } catch (e) { bad(`${key} RPC nem elérhető: ${(e as Error).message.slice(0, 100)}`); }
}

const jev = new JevClient(db, cfg, env.TYPESAFE_API_KEY);
const sampleState = {
  token: { chain: "base", launchpad: "clanker", age_sec: 60, sell_simulation: "ok", sell_tax_pct: 0, liquidity_locked: true, initial_liquidity_usd: 2500 },
  creator: { prior_tokens: 3, prior_rugged: 3, prior_graduated: 0, wallet_age_days: 2, status: "unknown" },
  holders: { count: 41, top10_pct_ex_creator: 62, funding_clusters_top20: 5, fresh_wallet_ratio: 0.8, airdrop_received_ratio: 0.1 },
  buyers: { smart_money: 0, known_scammers: 2, bot_ratio: 0.7, median_buy_usd: 12 },
  dynamics: { buys_per_min: 30, sells_per_min: 2, unique_buyers_per_min: 4, net_inflow_native: 1.2, price_change_pct: 140 },
  meta: { name: "PEPE2", symbol: "PEPE2", copycats_24h: 12, has_logo: true },
  social: { telegram: false, x: false, website: false, paid_boost: true },
};
try {
  const t0 = Date.now();
  const r = await jev.ask(sampleState, entryQuestions, { purpose: "verify" });
  const a = r.answers;
  ok(`Jev kötegelt hívás ok: ${Object.keys(entryQuestions).length} kérdés egy hívásban, ${r.inputTokens} input token, ${r.costUsd.toFixed(6)} USD, ${Date.now() - t0} ms`);
  console.log("   contract_risk:", a.contract_risk.choice, JSON.stringify(a.contract_risk.probabilities));
  console.log("   creator_profile:", a.creator_profile.choice, `(P=${a.creator_profile.confidence.toFixed(2)})`);
  console.log("   wallet_pattern:", a.wallet_pattern.choice, JSON.stringify(a.wallet_pattern.probabilities));
  console.log("   buyer_quality:", scoreTo100(a.buyer_quality.score), "/100");
  console.log("   trade_pattern:", a.trade_pattern.choice, " entry_timing:", a.entry_timing.choice);
  console.log("   outcome:", a.outcome.choice, JSON.stringify(a.outcome.probabilities));
  const row = db.prepare("SELECT id, ok, input_tokens, cost_usd, length(answers_json) len FROM jev_calls WHERE id = ?").get(r.callId);
  ok(`Jev-hívás DB-ben: ${JSON.stringify(row)}`);
  const s = await jev.ask("A token creatorja az összes tokenjét eladta az első percben.", smokeQuestions, { purpose: "verify" });
  ok(`Jev noul/choice/score teszt: P(rug)=${s.answers.is_rug.noul.toFixed(2)}, pattern=${s.answers.pattern.choice}, quality=${scoreTo100(s.answers.quality.score)}`);
} catch (e) { bad(`Jev-hívás hiba: ${(e as Error).message}`); }

const tg = new Telegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
const me = await tg.getMe();
if (!me) bad("Telegram getMe sikertelen (token?)");
else {
  ok(`Telegram bot: @${me.username}`);
  const sent = await tg.send(`✅ Jev Sniper – 1. lépés verify lefutott (${new Date().toISOString()})`);
  sent ? ok("Telegram üzenet elküldve") : bad("Telegram üzenet küldése sikertelen (chat_id? írtál már a botnak?)");
}
db.close();
