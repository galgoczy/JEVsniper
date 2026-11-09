/**
 * 6. lépés verify: valós Jev-válaszok egy szűrőn átment pillanatképre, élő szabály és árnyékkarok kiértékelése,
 * rezsim lekérése, és a Jev-hiba → szünet viselkedés (hibás kulccsal).
 * Futtatás: npm run verify:step6
 */
import { loadConfig } from "../src/config.js";
import { loadEnv } from "../src/env.js";
import { openDb } from "../src/db/index.js";
import { JevClient, JevPausedError } from "../src/jev/client.js";
import { entryQuestions, regimeQuestions } from "../src/jev/questions.js";
import { jevStateFromSnapshot } from "../src/decision/state.js";
import { labelsFrom, liveEntryRule, ruleScore, randomControlArm } from "../src/decision/rules.js";
import { hardFilters } from "../src/filters/hard.js";
import type { ParamSnapshot } from "../src/collector/types.js";

const ok = (m: string) => console.log("✅", m);
const bad = (m: string) => { console.log("❌", m); process.exitCode = 1; };
const cfg = loadConfig();
const env = loadEnv({ requireWallet: false });
const db = openDb(cfg.db.path);
const rows = db.prepare(`SELECT s.params_json, s.token_id, t.chain, t.launchpad, t.symbol, t.address FROM snapshots s JOIN tokens t ON t.id = s.token_id WHERE s.window_sec = ? ORDER BY s.id DESC LIMIT 300`)
  .all(cfg.evaluation.live_window_sec) as { params_json: string; token_id: number; chain: string; launchpad: string; symbol: string | null; address: string }[];
const cand = rows.map((r) => ({ ...r, snap: JSON.parse(r.params_json) as ParamSnapshot })).find((r) => hardFilters(r.snap, cfg.hard_filters).pass && Number(r.snap.dynamics.buys) > 0);
if (!cand) { bad("nincs szűrőn átment pillanatkép vételekkel (fusson a bot)"); process.exit(1); }
console.log(`Token: ${cand.chain}/${cand.launchpad} ${cand.symbol ?? "?"} ${cand.address}`);

const jev = new JevClient(db, { ...cfg, jev: { ...cfg.jev, enabled: true } }, env.TYPESAFE_API_KEY);
const state = jevStateFromSnapshot(cand.snap, { regime: "normal" });
const stateChars = JSON.stringify(state).length;
const t0 = Date.now();
const r = await jev.ask(state, entryQuestions, { purpose: "verify", tokenId: cand.token_id, windowSec: cand.snap.meta_snapshot.window_sec });
ok(`Jev belépési köteg: 12 kérdés, állapot ${stateChars} karakter, ${r.inputTokens} token, ${r.costUsd.toFixed(6)} USD, ${Date.now() - t0} ms`);
const l = labelsFrom(r.answers);
console.log("   címkék:", JSON.stringify(l));
const live = liveEntryRule(l, cand.snap, "normal", cfg.entry);
console.log(`   élő szabály: ${live.enter ? "BELÉP" : "nem lép be"} ${live.reasons.join(", ")}; méretszorzó ${live.sizeMultiplier}`);
console.log(`   rule_score: ${ruleScore(cand.snap)}; random_control: ${randomControlArm(cand.address, cfg.entry.random_control_share).enter ? "belép" : "nem"}`);

const rg = await jev.ask({ eth_change_24h_pct: -1.2, launchpads_24h: [{ launchpad: "pons", n: 400, graduation_rate: 0.05 }], gas_gwei: { base: 0.006, robinhood: 0.05 } }, regimeQuestions, { purpose: "verify" });
ok(`rezsim-kérdés: ${rg.answers.regime.choice} ${JSON.stringify(rg.answers.regime.probabilities)}`);

// Jev-hiba → szünet: hibás kulccsal 401 → 3 hiba után paused
const badCfg = { ...cfg, jev: { ...cfg.jev, enabled: true, max_retries: 0, pause_after_consecutive_errors: 2 } };
const broken = new JevClient(db, badCfg, "ts_invalid_key_for_verify_0000000000");
let paused = false;
for (let i = 0; i < 3; i++) { try { await broken.ask("x", regimeQuestions, { purpose: "verify" }); } catch (e) { if (e instanceof JevPausedError) paused = true; } }
paused ? ok("Jev-hiba után a kliens szünetel (nincs új belépés), a hívások jev_calls-ban naplózva") : bad("a Jev-kliens nem állt szünetre 2 hiba után");
db.close();
