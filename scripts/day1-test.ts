/**
 * 1. napi végrehajtási próba (spec 3.): 1 USD-s valódi tranzakciók.
 *   npm run day1 -- pick                       → tokenjavaslat láncenként a DB-ből (nem küld semmit)
 *   npm run day1 -- <lánc> <cím>               → SZÁRAZ próba: árajánlat, gas-becslés, nincs küldés
 *   npm run day1 -- <lánc> <cím> --confirm     → ÉLES: vétel 1 USD, eladás 50%, eladás maradék, szándékosan
 *                                                  sikertelen eladás, nonce-ellenőrzés; gas műveletenként
 * A /stop és /panic próbája a futó boton, Telegramról.
 */
import { loadConfig } from "../src/config.js";
import { loadEnv } from "../src/env.js";
import { openDb, nowMs } from "../src/db/index.js";
import { publicClient, rpcUrls, type ChainKey } from "../src/chains/index.js";
import { EthPrice, type TokenRow } from "../src/collector/index.js";
import { Executor } from "../src/exec/executor.js";
import { routeFor } from "../src/exec/routes.js";
import { formatEther, formatUnits, getAddress, parseEther } from "viem";

const cfg = loadConfig();
const env = loadEnv();
const db = openDb(cfg.db.path);
const clients = { base: publicClient("base", env.BASE_RPC_URL), robinhood: publicClient("robinhood", env.ROBINHOOD_RPC_URL) };
const ethPrice = new EthPrice(clients.base);
const [a1, a2, a3] = process.argv.slice(2);

if (a1 === "pick" || !a1) {
  // Javaslat: az utolsó 24 órában (min. 20 perce) felfedezett, szűrőn átment tokenek, a legtöbb vétellel; PONS előnyben (curve), Base-en Clanker/v4 PoolKey-vel.
  const rows = db.prepare(`SELECT t.chain, t.launchpad, t.symbol, t.address, t.graduated_at, t.pool_key_json, s.params_json FROM tokens t JOIN snapshots s ON s.token_id = t.id
    WHERE s.window_sec = ? AND t.status != 'filtered' AND t.discovered_at BETWEEN ? AND ? ORDER BY s.id DESC LIMIT 4000`)
    .all(cfg.evaluation.live_window_sec, Date.now() - 24 * 3600_000, Date.now() - 20 * 60_000) as { chain: string; launchpad: string; symbol: string | null; address: string; graduated_at: number | null; pool_key_json: string | null; params_json: string }[];
  const scored = rows.map((r) => { const p = JSON.parse(r.params_json); return { ...r, buys: Number(p.dynamics?.buys) || 0, holders: Number(p.holders?.count) || 0, liq: Number(p.contract?.liquidity_usd) || 0, sellSim: p.contract?.sell_simulation as string }; })
    .filter((r) => r.sellSim !== "failed");
  for (const chain of ["robinhood", "base"] as const) {
    const cands = scored.filter((r) => r.chain === chain && (chain === "robinhood" ? r.launchpad === "pons" : (r.launchpad === "clanker" || r.launchpad === "uniswap") && r.pool_key_json))
      .sort((a, b) => b.buys - a.buys).slice(0, 3);
    console.log(`\n== ${chain} javaslatok (vételek / holderek az élő ablakban):`);
    if (!cands.length) console.log("   nincs jelölt (fusson tovább a bot)");
    for (const c of cands) console.log(`   ${c.launchpad} ${c.symbol ?? "?"} ${c.address}  vételek=${c.buys} holderek=${c.holders} ${c.graduated_at ? "(graduált)" : ""}`);
  }
  console.log("\nÉles próba: npm run day1 -- <lánc> <cím> --confirm");
  process.exit(0);
}

const chain = a1 as ChainKey, address = getAddress(a2!), confirm = a3 === "--confirm";
const row = db.prepare("SELECT * FROM tokens WHERE chain = ? AND lower(address) = lower(?)").get(chain, address) as TokenRow | undefined;
if (!row) { console.log("❌ a token nincs a DB-ben"); process.exit(1); }
const sendUrl = (chain === "base" ? env.BASE_PRIVATE_TX_RPC_URL : env.ROBINHOOD_PRIVATE_TX_RPC_URL) || rpcUrls(chain === "base" ? env.BASE_RPC_URL : env.ROBINHOOD_RPC_URL)[0]!;
const ex = new Executor(chain, clients[chain], db, cfg, env.WALLET_PRIVATE_KEY as `0x${string}`, sendUrl, () => ethPrice.get());
const eth = await ethPrice.get();
if (typeof eth !== "number") { console.log("❌ nincs ETH/USD ár"); process.exit(1); }
const usd = (wei: bigint) => (Number(formatEther(wei)) * eth).toFixed(4);
const oneUsdWei = parseEther((cfg.risk.base_position_usd / eth).toFixed(18));
console.log(`Token: ${chain}/${row.launchpad} ${row.symbol ?? "?"} ${address}\nWallet: ${ex.address}, egyenleg ${formatEther(await ex.nativeBalance())} ETH (ETH=${eth.toFixed(0)} USD)\nPozíció: ${cfg.risk.base_position_usd} USD = ${formatEther(oneUsdWei)} ETH, mód: ${confirm ? "ÉLES" : "száraz"}`);

const route = await routeFor(clients[chain], chain, row);
console.log(`Útvonal: ${route.kind}`);
let q;
try { q = await route.quoteBuy(oneUsdWei, ex.address); }
catch (e) {
  const m = (e as Error).message;
  const reason = m.includes("NotEnoughLiquidity") || m.includes("6190b2b0") ? "a poolnak nincs likviditása (Quoter: NotEnoughLiquidity)" : m.split("\n")[0]!.slice(0, 160);
  console.log(`❌ Nem árazható, ez a token nem vehető meg: ${reason}\n   Válassz másik jelöltet (npm run day1 -- pick).`); process.exit(1);
}
console.log(`Árajánlat vétel: ${formatUnits(q.amountOut, 18)} token, díj ${usd(q.feeWei)} USD, adó ${usd(q.taxWei)} USD ${q.note ?? ""}`);
const buyTx = route.buildBuy(oneUsdWei, (q.amountOut * 92n) / 100n, ex.address, cfg.execution.deadline_sec);
const gas = await clients[chain].estimateGas({ account: ex.address, to: buyTx.to, data: buyTx.data, value: buyTx.value });
const gp = await clients[chain].getGasPrice();
console.log(`Gas-becslés vétel: ${gas} gas × ${Number(gp) / 1e9} gwei = ${usd(gas * gp)} USD (plafon ${cfg.risk.max_gas_per_tx_usd} USD)`);
if (!confirm) { console.log("\nSzáraz próba kész. Éles: ugyanez --confirm kapcsolóval."); process.exit(0); }

// ---- ÉLES ----
const posId = Number(db.prepare(`INSERT INTO positions(token_id, chain, arm, exit_plan, window_sec, opened_at, entry_price_native, size_usd, size_native, tokens_bought, tokens_remaining, phase)
  VALUES (?,?,'day1_test','live',?,?,0,?,?,0,0,'pre_tp1')`).run(row.id, chain, cfg.evaluation.live_window_sec, nowMs(), cfg.risk.base_position_usd, Number(formatEther(oneUsdWei))).lastInsertRowid);
const ops: { op: string; ok: boolean; gasUsd: number | null; hash: string | null; note: string }[] = [];
const nonce0 = await ex.nextNonce();

const b = await ex.buy(route, address, oneUsdWei, cfg.execution.max_slippage_pct, { positionId: posId });
ops.push({ op: "vétel 1 USD", ok: b.ok, gasUsd: b.gasUsd, hash: b.hash, note: `kapott ${formatUnits(b.tokensReceived, 18)} (becsült ${formatUnits(b.quote.amountOut, 18)}, csúszás ${(100 - Number(b.tokensReceived * 10000n / (b.quote.amountOut || 1n)) / 100).toFixed(2)}%)` });
if (!b.ok) { console.log("❌ a vétel sikertelen:", b.error); }
else {
  db.prepare("UPDATE positions SET tokens_bought = ?, tokens_remaining = ?, entry_price_native = ? WHERE id = ?").run(Number(formatUnits(b.tokensReceived, 18)), Number(formatUnits(b.tokensReceived, 18)), Number(oneUsdWei) / Number(b.tokensReceived || 1n), posId);
  const half = b.tokensReceived / 2n;
  // szándékosan sikertelen eladás: irreális minOut (10x) → revert; számít a hibaszámlálóba, utána nullázzuk
  const bad = await route.buildSell(half, b.quote.amountOut * 10n, ex.address, cfg.execution.deadline_sec, ex.address);
  let badRes = null;
  for (const tx of bad) { badRes = await ex.send(tx, { isSell: true, positionId: posId, kind: tx.label.includes("approve") || tx.label.includes("permit2") ? "approve" : "sell_failed" }); if (!badRes.ok) break; }
  ops.push({ op: "szándékosan sikertelen eladás", ok: badRes?.ok === false, gasUsd: badRes?.gasUsd ?? null, hash: badRes?.hash ?? null, note: badRes?.ok === false ? `revert kezelve: ${badRes.error}` : "NEM bukott el – vizsgálni" });
  const s1 = await ex.sell(route, address, half, cfg.execution.max_slippage_pct, { positionId: posId });
  ops.push({ op: "részleges eladás 50%", ok: s1.ok, gasUsd: s1.gasUsd, hash: s1.hash, note: s1.unsellable ? "NEM ELADHATÓ" : `kapott ${formatEther(s1.nativeReceived)} ETH, csúszás-lépcső ${s1.slippagePct}%` });
  const rest = await ex.tokenBalance(address);
  const s2 = await ex.sell(route, address, rest, cfg.execution.max_slippage_pct, { positionId: posId });
  ops.push({ op: "teljes eladás (maradék)", ok: s2.ok, gasUsd: s2.gasUsd, hash: s2.hash, note: s2.unsellable ? "NEM ELADHATÓ" : `kapott ${formatEther(s2.nativeReceived)} ETH` });
  db.prepare("UPDATE positions SET tokens_remaining = 0, phase = 'closed', closed_at = ?, close_reason = 'day1_test' WHERE id = ?").run(nowMs(), posId);
}
const nonce1 = await ex.nextNonce();
const dbNonce = (db.prepare("SELECT next_nonce FROM nonces WHERE chain = ?").get(chain) as { next_nonce: number }).next_nonce;
ops.push({ op: "nonce", ok: nonce1 === dbNonce, gasUsd: null, hash: null, note: `indulás ${nonce0} → most lánc ${nonce1}, DB ${dbNonce} (újraindítás után a DB-ből folytat)` });
db.prepare("UPDATE daily_state SET consecutive_failed_tx = 0 WHERE day = date('now')").run();

console.log("\n== Eredmény");
for (const o of ops) console.log(`${o.ok ? "✅" : "❌"} ${o.op}: gas ${o.gasUsd !== null ? o.gasUsd.toFixed(4) + " USD" : "-"} ${o.hash ?? ""} ${o.note}`);
const fills = db.prepare("SELECT kind, status, real_gas_usd, est_gas_usd, tx_hash FROM fills WHERE position_id = ? ORDER BY id").all(posId) as Record<string, unknown>[];
console.log(`\nDB fills (${fills.length} sor):`); for (const f of fills) console.log("  ", JSON.stringify(f));
const gasSum = ops.reduce((s, o) => s + (o.gasUsd ?? 0), 0);
console.log(`\nÖsszes gas ebben a körben: ${gasSum.toFixed(4)} USD → javasolt max_gas_per_tx_usd ≈ ${Math.max(0.05, (Math.max(...ops.map((o) => o.gasUsd ?? 0)) * 2)).toFixed(3)} (config.yaml risk.)`);
db.close();
