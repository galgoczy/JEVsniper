/**
 * Base csalásszűrő visszamérése (2026-10-11): a korábbi árnyék-pozíciók tokenjeire a scamscan, CSAK a belépésig ismert adatból
 * (indulás blokkja → az első 30/60 mp-es árnyék-belépés blokkja), majd a karok eredménye tiszta / jelzett bontásban.
 *   npm run scam:backfill            (hiányzók kitöltése + értékelés)   -- --eval   (csak értékelés)
 */
import { loadConfig } from "../src/config.js"; import { loadEnv } from "../src/env.js"; import { openDb, nowMs } from "../src/db/index.js";
import { publicClient } from "../src/chains/index.js"; import { scanToken, scamFlags, looksLikeAddress } from "../src/filters/scamscan.js"; import { getAddress } from "viem";

const cfg = loadConfig(); const env = loadEnv(); const db = openDb(cfg.db.path); const c = publicClient("base", env.BASE_RPC_URL);
const SINCE = Date.parse("2026-09-30T00:00:00Z");
const ARMS = ["rule_v2_strict", "rule_v2", "rule_v2_nofactory", "base_uni_hold", "base_uni_hold_nofactory", "random_control"];
const marked = new Set((db.prepare("SELECT addr FROM base_scam_marks").all() as { addr: string }[]).map((r) => r.addr));

if (!process.argv.includes("--eval")) {
  const toks = db.prepare(`SELECT t.id, t.address, t.discovered_at d, t.discovered_block b, MIN(p.opened_at) o, GROUP_CONCAT(DISTINCT p.arm) arms FROM positions p JOIN tokens t ON t.id = p.token_id
    WHERE p.chain = 'base' AND p.exit_plan = 'live' AND p.window_sec IN (30, 60) AND p.arm IN (${ARMS.map(() => "?").join(",")}) AND p.opened_at > ?
      AND COALESCE(p.close_reason,'') NOT LIKE 'invalid%' AND t.discovered_block IS NOT NULL AND t.id NOT IN (SELECT token_id FROM base_scam_checks WHERE error IS NULL)
    GROUP BY t.id ORDER BY t.id`).all(...ARMS, SINCE) as Array<{ id: number; address: string; d: number; b: number; o: number; arms: string }>;
  // a véletlen kontrollból csak minden 4. token (elég a viszonyításhoz)
  const list = toks.filter((t) => t.arms !== "random_control" || t.id % 4 === 0);
  console.log(`vizsgálandó token: ${list.length}`);
  const ins = db.prepare(`INSERT OR REPLACE INTO base_scam_checks(token_id, at, upto_block, embedded, buys, top_router, top_share, top_v0, top_embedded, forced, flags, error, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'backfill')`);
  let done = 0;
  const work = async (t: typeof list[number]) => {
    const upto = BigInt(t.b) + BigInt(Math.max(0, Math.round((t.o - t.d) / 2000)));
    try {
      const s = await scanToken(c, getAddress(t.address), BigInt(t.b) - 3n, upto, { marked, codeAt: upto });
      ins.run(t.id, nowMs(), Number(upto), JSON.stringify(s.embedded), s.buys, s.topRouter, s.topRouterShare, s.topRouterValue0, s.topRouterEmbedded ? 1 : 0, s.forced, s.flags.join(","), null);
    } catch (e) { ins.run(t.id, nowMs(), Number(upto), null, null, null, null, null, null, null, null, (e as Error).message.slice(0, 160)); }
    if (++done % 25 === 0) console.log(`  ${done}/${list.length}`);
  };
  for (let i = 0; i < list.length; i += 3) await Promise.all(list.slice(i, i + 3).map(work));
}

// a tárolt sorok jeleinek újraszámolása a mostani szabállyal (pl. a metaadat-töredék szűrése után)
{
  const rs = db.prepare("SELECT token_id, embedded, buys, top_router, top_share, top_v0, forced FROM base_scam_checks WHERE error IS NULL").all() as Array<{ token_id: number; embedded: string; buys: number; top_router: string | null; top_share: number | null; top_v0: number | null; forced: number }>;
  const up = db.prepare("UPDATE base_scam_checks SET embedded = ?, top_embedded = ?, flags = ? WHERE token_id = ?");
  for (const r of rs) {
    const emb = (JSON.parse(r.embedded) as string[]).filter(looksLikeAddress);
    const s = { embedded: emb, buys: r.buys, topRouter: r.top_router, topRouterShare: r.top_share, topRouterValue0: r.top_v0, topRouterEmbedded: !!r.top_router && emb.includes(r.top_router), forced: r.forced };
    up.run(JSON.stringify(emb), s.topRouterEmbedded ? 1 : 0, scamFlags(s, marked).join(","), r.token_id);
  }
}

// értékelés: karonként (élő terv, 30 és 60 mp) tiszta vs. jelzett, és jelenként
const rows = db.prepare(`SELECT p.arm, p.window_sec w, p.net_pnl_usd v, s.flags f, s.error e FROM positions p JOIN base_scam_checks s ON s.token_id = p.token_id
  WHERE p.chain = 'base' AND p.exit_plan = 'live' AND p.window_sec IN (30, 60) AND p.arm IN (${ARMS.map(() => "?").join(",")}) AND p.opened_at > ? AND p.closed_at IS NOT NULL
    AND COALESCE(p.close_reason,'') NOT LIKE 'invalid%'`).all(...ARMS, SINCE) as Array<{ arm: string; w: number; v: number; f: string | null; e: string | null }>;
const st = (xs: number[]) => xs.length ? `${(xs.reduce((a, b) => a + b, 0) / xs.length >= 0 ? "+" : "")}${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)} (n=${xs.length}, nagy nyerő ${xs.filter((x) => x >= 2).length})` : "–";
console.log("\nkar / ablak | minden | TISZTA | jelzett | hiba");
for (const arm of ARMS) for (const w of [30, 60]) {
  const r = rows.filter((x) => x.arm === arm && x.w === w); if (!r.length) continue;
  console.log(`${arm} ${w}s | ${st(r.map((x) => x.v))} | ${st(r.filter((x) => !x.e && !x.f).map((x) => x.v))} | ${st(r.filter((x) => !x.e && x.f).map((x) => x.v))} | ${r.filter((x) => x.e).length}`);
}
console.log("\njelenként (60s, élő terv, minden vizsgált kar együtt, tokenenként egyszer):");
const per = db.prepare(`SELECT s.flags f, COUNT(*) n FROM base_scam_checks s GROUP BY s.flags ORDER BY n DESC`).all() as { f: string | null; n: number }[];
for (const p of per) console.log(`  ${p.f === null ? "(hiba)" : p.f || "(tiszta)"}: ${p.n} token`);
