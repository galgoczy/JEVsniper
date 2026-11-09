/**
 * Egyszeri javítás (2026-10-06): a hamis PONS-„graduációk” visszaállítása.
 * Botok idegen (nem PONS-hookos, 79–88% díjú) v4 por-poolokat nyitottak a görbén lévő tokeneknek; a figyelő ezeket
 * graduációnak vette (graduated_at + pool_key_json), és az árfigyelő onnan olvasta az árat.
 * Lépések: (1) a nem PONS-hookos PoolKey-ű PONS-tokenek listája; (2) a görbe `graduated()` lekérdezése; (3) ha a görbe
 * valóban graduált: a hivatalos PoolKey (factory rekord + PONS hook) és a graduáció ideje az Initialize eseményből;
 * különben graduated_at = NULL, pool_key_json = NULL. (4) --apply nélkül csak kiírja, mit tenne.
 * Pozíciók: az érintett tokenek Robinhood-pozíciói, amelyek a hamis graduáció után még nyitva voltak (az ár a por-poolból
 * jött) → invalid_fake_pool:<eredeti ok>; a hamis graduáción nyitott grad_* pozíciók szintén.
 * Használat: npx tsx scripts/fix-fake-grads.ts [--apply]
 */
import "dotenv/config";
import { getAddress, isAddressEqual, type Address } from "viem";
import { loadConfig } from "../src/config.js";
import { loadEnv } from "../src/env.js";
import { openDb } from "../src/db/index.js";
import { publicClient } from "../src/chains/index.js";
import { ADDRESSES } from "../src/chains/addresses.js";
import { ponsCurveAbi, ponsFactoryAbi } from "../src/abis/pons.js";
import { uniswapV4PoolManagerAbi } from "../src/abis/uniswap.js";
import { computePoolId, type PoolKey } from "../src/exec/routes.js";

const apply = process.argv.includes("--apply");
const cfg = loadConfig(), env = loadEnv({ requireWallet: false }), db = openDb(cfg.db.path);
const A = ADDRESSES.robinhood, hook = A.ponsV2Hook!;
const c = publicClient("robinhood", env.ROBINHOOD_RPC_URL);
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

const rows = (db.prepare(`SELECT id, symbol, address, pool_address, pool_key_json, graduated_at, discovered_block FROM tokens
  WHERE chain = 'robinhood' AND launchpad = 'pons' AND graduated_at IS NOT NULL`).all() as Array<{ id: number; symbol: string; address: string; pool_address: string | null; pool_key_json: string | null; graduated_at: number; discovered_block: number | null }>)
  .filter((r) => { const pk = r.pool_key_json ? JSON.parse(r.pool_key_json) as PoolKey : null; return !pk || !isAddressEqual(pk.hooks as Address, hook); });
console.log(`nem PONS-hookos graduáció: ${rows.length} token`);

// (2) görbe graduated()
const curveRows = rows.filter((r) => r.pool_address && /^0x[0-9a-fA-F]{40}$/.test(r.pool_address));
const grad = new Map<number, boolean>();
for (let i = 0; i < curveRows.length; i += 200) {
  const part = curveRows.slice(i, i + 200);
  const mc = await c.multicall({ allowFailure: true, contracts: part.map((r) => ({ address: getAddress(r.pool_address!), abi: ponsCurveAbi, functionName: "graduated" as const })) });
  part.forEach((r, k) => { if (mc[k]?.status === "success") grad.set(r.id, mc[k]!.result as boolean); });
}
const real = rows.filter((r) => grad.get(r.id) === true), unknown = rows.filter((r) => !grad.has(r.id));
console.log(`ebből a görbe valóban graduált: ${real.length}; ismeretlen (nincs görbe-cím / hiba): ${unknown.length}`);

// (3) valódi graduáció: hivatalos PoolKey + Initialize ideje
const fixes = new Map<number, { pk: PoolKey; at: number | null }>();
const head = await c.getBlockNumber();
const initEv = uniswapV4PoolManagerAbi.find((x) => x.type === "event" && x.name === "Initialize")!;
const want = new Map<string, number>(); // poolId → token id
for (const r of real) {
  const rec = await c.readContract({ address: A.ponsV2Factory!, abi: ponsFactoryAbi, functionName: "getLaunchedToken", args: [getAddress(r.address)] }).catch(() => null) as { pairToken: Address; poolFee: number; tickSpacing: number } | null;
  if (!rec) { console.log(`  ${r.symbol}: factory-rekord nem olvasható`); continue; }
  const token = getAddress(r.address), pair = isAddressEqual(rec.pairToken, ZERO) ? ZERO : getAddress(rec.pairToken);
  const [c0, c1] = BigInt(token) < BigInt(pair) ? [token, pair] : [pair, token];
  const pk: PoolKey = { currency0: c0, currency1: c1, fee: Number(rec.poolFee), tickSpacing: Number(rec.tickSpacing), hooks: getAddress(hook) };
  fixes.set(r.id, { pk, at: null }); want.set(computePoolId(pk).toLowerCase(), r.id);
}
// egyetlen végigolvasás: a PONS-hookos Initialize események (a hook nem indexelt → poolId szerinti szűrés kötegekben)
const startBlock = BigInt(Math.min(...real.map((r) => r.discovered_block ?? Number(head))));
const ids = [...want.keys()] as `0x${string}`[];
const blockTs = new Map<bigint, number>();
for (let f = startBlock; f <= head; f += 50_000n) {
  const to = f + 49_999n > head ? head : f + 49_999n;
  for (let i = 0; i < ids.length; i += 100) {
    const logs = await c.getLogs({ address: A.uniswapV4PoolManager!, event: initEv as never, args: { id: ids.slice(i, i + 100) } as never, fromBlock: f, toBlock: to })
      .catch((e) => { console.log(`  getLogs hiba (${f}): ${(e as Error).message.slice(0, 80)}`); return []; }) as Array<{ blockNumber: bigint | null; args: { id: string } }>;
    for (const l of logs) {
      const tid = want.get(l.args.id.toLowerCase()); if (tid === undefined || !l.blockNumber) continue;
      if (!blockTs.has(l.blockNumber)) blockTs.set(l.blockNumber, Number((await c.getBlock({ blockNumber: l.blockNumber })).timestamp) * 1000);
      fixes.get(tid)!.at = blockTs.get(l.blockNumber)!;
    }
  }
}
console.log(`hivatalos pool: ${fixes.size}, graduációs idő megvan: ${[...fixes.values()].filter((f) => f.at).length}`);

// (4) pozíciók
const fakeIds = rows.filter((r) => !fixes.has(r.id) && !unknown.includes(r)).map((r) => r.id);
const allIds = rows.filter((r) => !unknown.includes(r)).map((r) => r.id);
const cnt = (sql: string, ids: number[]) => ids.length ? (db.prepare(sql.replace("$IDS", ids.join(","))).get() as { n: number }).n : 0;
const affected = cnt(`SELECT count(*) n FROM positions p JOIN tokens t ON t.id = p.token_id WHERE t.id IN ($IDS) AND (p.closed_at IS NULL OR p.closed_at > t.graduated_at) AND (p.close_reason IS NULL OR p.close_reason NOT LIKE 'invalid%')`, allIds);
console.log(`érintett pozíciók (a hamis graduáció után még nyitva / grad_* a hamis graduáción): ${affected}`);
if (!apply) { console.log("(próbafutás – a módosításhoz: --apply)"); process.exit(0); }

const tx = db.transaction(() => {
  const ids = allIds.join(",");
  if (ids) {
    db.prepare(`UPDATE positions SET close_reason = 'invalid_fake_pool:' || COALESCE(close_reason, 'nyitott'), closed_at = COALESCE(closed_at, ?), phase = 'closed', net_pnl_usd = 0
      WHERE token_id IN (${ids}) AND (closed_at IS NULL OR closed_at > (SELECT graduated_at FROM tokens t WHERE t.id = positions.token_id)) AND (close_reason IS NULL OR close_reason NOT LIKE 'invalid%')`).run(Date.now());
  }
  for (const id of fakeIds) db.prepare("UPDATE tokens SET graduated_at = NULL, pool_key_json = NULL WHERE id = ?").run(id);
  for (const [id, f] of fixes) db.prepare("UPDATE tokens SET graduated_at = COALESCE(?, graduated_at), pool_key_json = ? WHERE id = ?").run(f.at, JSON.stringify(f.pk), id);
});
tx();
console.log(`kész: ${fakeIds.length} token visszaállítva görbére, ${fixes.size} token hivatalos poolra javítva`);
