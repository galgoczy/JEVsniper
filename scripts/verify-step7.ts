/**
 * 7. lépés verify: kézzel végigszámolt példa (árnyék-pozíció az élő tervvel, 2x → 5x → 20x) egyezik a monitor számításával;
 * plusz a valódi DB nyitott pozícióinak és a 24 órás kimenet-követésnek az állapota.
 * Futtatás: npm run verify:step7   (nem kell RPC)
 */
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { PositionMonitor, type PosRow } from "../src/exit/monitor.js";
import type { PriceFeed, PriceState } from "../src/exit/pricefeed.js";
import { shadowCost } from "../src/exit/costmodel.js";

const ok = (m: string) => console.log("✅", m);
const bad = (m: string) => { console.log("❌", m); process.exitCode = 1; };
const cfg = loadConfig();
const ETH = 2500, ENTRY = 1e-6, LIQ = 10;

// --- kézi számítás
const sizeNative = 1 / ETH;                                                     // 0.0004 ETH
const buy = shadowCost("robinhood", "buy", sizeNative, { feePct: 2, liquidityNative: LIQ }, cfg.cost_model);
const tokens = buy.netNative / ENTRY;
const sellNet = (tok: number, price: number) => shadowCost("robinhood", "sell", tok * price, { feePct: 2, liquidityNative: LIQ }, cfg.cost_model).netNative;
const handNative = sellNet(tokens * 0.5, 2e-6) + sellNet(tokens * 0.3, 5e-6) + sellNet(tokens * 0.2, 20e-6);
const handGas = buy.gasUsd + 3 * cfg.cost_model.robinhood.gas_sell_usd;
const handNet = (handNative - sizeNative) * ETH - handGas;
console.log(`Kézi példa: 1 USD @ ETH ${ETH}, belépés ${ENTRY} ETH/token, likviditás ${LIQ} ETH, curve díj 2%`);
console.log(`  vett token: ${tokens.toFixed(4)} (nettó ${buy.netNative.toFixed(8)} ETH a ${sizeNative} ETH-ból)`);
console.log(`  eladások: 50% @2x, 30% @5x, 20% @20x → ${handNative.toFixed(8)} ETH; gas ${handGas.toFixed(3)} USD; nettó ${handNet.toFixed(4)} USD (${((handNative / sizeNative)).toFixed(2)}x bruttó)`);

// --- monitor szimuláció memóriában
const db = openDb(":memory:");
db.prepare("INSERT INTO tokens(id, chain, address, creator, launchpad, mechanics, pool_address, discovered_at) VALUES (1,'robinhood','0x1','0xc','pons','bonding_curve','0xcurve',0)").run();
const t0 = Date.now() - 60_000; // 1 perce nyitva (a 7 napos limit ne szóljon bele)
db.prepare(`INSERT INTO positions(id, token_id, chain, arm, exit_plan, window_sec, opened_at, entry_price_native, size_usd, size_native, tokens_bought, tokens_remaining, phase, peak_price_native, gas_usd, liquidity_at_entry, next_check_at)
  VALUES (1,1,'robinhood','live_rule','live',60,?,?,1,?,?,?,'pre_tp1',?,?,?,0)`).run(t0, ENTRY, sizeNative, tokens, tokens, ENTRY, buy.gasUsd, LIQ);
let price = ENTRY;
const feed = { get: (): PriceState => ({ price, at: 0, block: 0n, liquidityNative: LIQ, creatorBalance: null, swapsSinceLast: 0, sellsSinceLast: 0, graduated: false }) } as unknown as PriceFeed;
const mon = new PositionMonitor({ db, cfg, jev: null as never, executors: {}, feeds: { base: feed, robinhood: feed }, ethUsd: async () => ETH, regime: () => "normal", notify: async () => undefined });
const row = () => db.prepare("SELECT p.*, t.address, t.symbol, t.launchpad, t.mechanics, t.pool_address, t.pool_key_json, t.creator, t.pair_token, t.graduated_at FROM positions p JOIN tokens t ON t.id=p.token_id WHERE p.id=1").get() as PosRow;
for (const [p, label] of [[1.5e-6, "1.5x: semmi"], [2e-6, "2x: 50% el"], [3e-6, "3x: semmi"], [5e-6, "5x: 30% el"], [12e-6, "12x: semmi (moon bag)"], [20e-6, "20x: maradék el, zárva"]] as const) {
  price = p; await mon.checkPosition(row());
  const r = row();
  console.log(`  ${label.padEnd(26)} → fázis ${r.phase}, maradék ${r.tokens_remaining.toFixed(4)}, kapott ${r.native_received.toFixed(8)} ETH`);
}
await new Promise((r) => setTimeout(r, 50));
const fin = row();
const diff = Math.abs((fin.net_pnl_usd ?? NaN) - handNet);
console.log(`  monitor nettó: ${fin.net_pnl_usd?.toFixed(4)} USD, kézi: ${handNet.toFixed(4)} USD, ok: ${fin.close_reason}`);
diff < 1e-6 && fin.phase === "closed" ? ok("a monitor számítása egyezik a kézi példával") : bad(`eltérés ${diff}`);

// vészfék: -40%
db.prepare("UPDATE positions SET phase='pre_tp1', tokens_remaining=tokens_bought, closed_at=NULL, close_reason=NULL, native_received=0, peak_price_native=? WHERE id=1").run(ENTRY);
price = 0.59e-6; await mon.checkPosition(row());
row().close_reason?.startsWith("emergency:price_drop") ? ok(`vészkilépés -40%-nál: ${row().close_reason}`) : bad("nem lépett ki -40%-nál");
db.close();

// --- valódi DB állapot
const real = openDb(cfg.db.path);
const open = real.prepare("SELECT arm, COUNT(*) n FROM positions WHERE closed_at IS NULL AND arm != 'day1_test' AND tokens_bought > 0 GROUP BY arm ORDER BY n DESC").all() as { arm: string; n: number }[];
const closed = real.prepare("SELECT arm, exit_plan, COUNT(*) n, ROUND(AVG(net_pnl_usd),4) avg_net, SUM(net_pnl_usd>0) wins FROM positions WHERE closed_at IS NOT NULL AND arm != 'day1_test' AND close_reason != 'invalid_no_tokens' GROUP BY arm, exit_plan ORDER BY arm, exit_plan").all() as Record<string, unknown>[];
const oc = real.prepare("SELECT COUNT(*) n, SUM(first_hit='tp1_first') tp1, SUM(first_hit='stop_first') stop, SUM(done_at IS NOT NULL) done FROM token_outcomes").get() as Record<string, number>;
console.log(`\nValódi DB: nyitott árnyék-pozíciók karonként (7 terv/belépés): ${open.map((o) => `${o.arm}=${o.n}`).join(", ") || "nincs"}`);
console.log(`lezártak karonként/tervenként (db, átlag nettó USD, nyerők):`); for (const c of closed) console.log("  ", JSON.stringify(c)); if (!closed.length) console.log("   nincs");
const diag = real.prepare(`SELECT t.symbol, t.launchpad, t.graduated_at IS NOT NULL g, p.window_sec w, p.entry_price_native e, p.native_received / p.size_native x, p.close_reason r, (p.closed_at - p.opened_at)/1000 held_s
  FROM positions p JOIN tokens t ON t.id = p.token_id WHERE p.arm = 'jev_direct_0.3' AND p.exit_plan = 'live' AND p.closed_at IS NOT NULL AND p.close_reason != 'invalid_no_tokens' ORDER BY p.closed_at DESC LIMIT 12`).all() as Record<string, unknown>[];
console.log("diagnosztika (jev_direct_0.3 élő terv, utolsó 12 zárás): ablak | graduált | szorzó | ok | tartás mp");
for (const d of diag) console.log(`   ${d.launchpad} ${String(d.symbol ?? "?").padEnd(10)} ${d.w}s  grad=${d.g}  x=${Number(d.x).toFixed(3)}  ${d.r}  ${Math.round(Number(d.held_s))}s`);
console.log(`kimenet-követés: ${oc.n} token, 2x előbb: ${oc.tp1 ?? 0}, -40% előbb: ${oc.stop ?? 0}, lezárt 24h: ${oc.done ?? 0}`);
real.close();
