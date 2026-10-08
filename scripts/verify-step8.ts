/** 8. lépés verify: kézi példa (3 nyerő, 2 vesztes, egy 30%-os visszaesés) végigszámolva a bot függvényeivel + a valódi compound-állapot. */
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { applyClose, computePositionUsd, effectiveGrowth, type CompoundState } from "../src/compound/index.js";
const cfg = loadConfig();
let s: CompoundState = { deposit_usd: 30, growth_pool_usd: 0, reserve_usd: 0, working_capital_peak_usd: 30, position_usd: 1, updated_at: 0 };
console.log("Kézi példa – betét 30, alap 1 USD, max 15 pozíció, 30% kassza / 70% tartalék");
for (const [net, label] of [[2, "nyerő +2"], [-1, "vesztes −1"], [3, "nyerő +3"], [-0.8, "vesztes −0.8"], [5, "nyerő +5"]] as const) {
  s = applyClose(s, net, cfg.compound.profit_share_to_growth_pool);
  console.log(`  ${label.padEnd(12)} → betét ${s.deposit_usd.toFixed(2)}, kassza ${s.growth_pool_usd.toFixed(2)}, tartalék ${s.reserve_usd.toFixed(2)}, forgó ${(s.deposit_usd + s.growth_pool_usd).toFixed(2)}, csúcs ${s.working_capital_peak_usd.toFixed(2)}`);
}
const size1 = computePositionUsd(s, cfg.risk, cfg.compound, true);
console.log(`  méret 0:00-kor: 1 + ${s.growth_pool_usd.toFixed(2)}/15 = ${size1.toFixed(3)} USD  (kézzel: 1,200)`);
s = applyClose(s, -10, cfg.compound.profit_share_to_growth_pool);
const dd = effectiveGrowth(s, cfg.compound.drawdown_halving_pct);
console.log(`  nagy vesztes −10 → forgó ${(s.deposit_usd + s.growth_pool_usd).toFixed(2)} a ${s.working_capital_peak_usd.toFixed(2)} csúcshoz képest (−${((1 - (s.deposit_usd + s.growth_pool_usd) / s.working_capital_peak_usd) * 100).toFixed(0)}%) → visszaesés: ${dd.inDrawdown}`);
const size2 = computePositionUsd(s, cfg.risk, cfg.compound, true);
console.log(`  méret: 1 + ${dd.effective.toFixed(2)}/15 = ${size2.toFixed(3)} USD; tartalék érintetlen: ${s.reserve_usd.toFixed(2)}`);
const okAll = Math.abs(size1 - 1.2) < 1e-9 && dd.inDrawdown && Math.abs(s.reserve_usd - 7) < 1e-9 && Math.abs(size2 - 1.1) < 1e-9;
console.log(okAll ? "✅ a kézi példa egyezik a bot számításával" : "❌ eltérés a kézi példától");
const db = openDb(cfg.db.path);
const real = db.prepare("SELECT * FROM compound_state WHERE id = 1").get() as CompoundState | undefined;
console.log(`\nValódi állapot: ${real ? `betét ${real.deposit_usd}, kassza ${real.growth_pool_usd}, tartalék ${real.reserve_usd}, csúcs ${real.working_capital_peak_usd}, pozícióméret ${real.position_usd} USD` : "még nincs"}`);
console.log(`méretváltozások: ${(db.prepare("SELECT COUNT(*) n FROM size_changes").get() as { n: number }).n}`);
db.close();
