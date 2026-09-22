/**
 * 2. lépés verify: (a) a címeken van szerződéskód, (b) az elmúlt N blokkban jönnek-e események,
 * (c) a DB-ben lévő tokenek összesítése láncenként/launchpadonként.
 * Futtatás: npm run verify:step2   (élő RPC kell; a bot futása közben is mehet)
 */
import { loadConfig } from "../src/config.js";
import { loadEnv } from "../src/env.js";
import { openDb } from "../src/db/index.js";
import { publicClient, type ChainKey } from "../src/chains/index.js";
import { sourcesFor } from "../src/watchers/sources.js";

const ok = (m: string) => console.log("✅", m);
const bad = (m: string) => { console.log("❌", m); process.exitCode = 1; };
const cfg = loadConfig();
const env = loadEnv({ requireWallet: false });
const rpc: Record<ChainKey, string> = { base: env.BASE_RPC_URL, robinhood: env.ROBINHOOD_RPC_URL };

for (const chain of ["base", "robinhood"] as ChainKey[]) {
  if (!cfg.chains[chain].enabled) continue;
  const c = publicClient(chain, rpc[chain]);
  const head = await c.getBlockNumber();
  const lookback = BigInt(chain === "base" ? 1800 : 12000); // ~1 óra
  console.log(`\n== ${chain} (blokk ${head}, visszanézés ${lookback} blokk ≈ 1 óra)`);
  for (const src of sourcesFor(chain, cfg.watcher[chain].sources)) {
    const code = await c.getCode({ address: src.address });
    if (!code || code === "0x") { bad(`${src.key}: nincs kód a címen ${src.address}`); continue; }
    let total = 0, decoded = 0;
    const step = BigInt(cfg.watcher[chain].max_block_range) * 4n;
    for (let from = head - lookback; from <= head; from += step + 1n) {
      const to = from + step > head ? head : from + step;
      try {
        const logs = await c.getLogs({ address: src.address, event: src.event, fromBlock: from, toBlock: to });
        total += logs.length;
        for (const l of logs) { try { if (src.decode(l)) decoded++; } catch { /* ignore */ } }
      } catch (e) { bad(`${src.key}: getLogs hiba ${from}-${to}: ${(e as Error).message.slice(0, 120)}`); break; }
    }
    ok(`${src.key} @ ${src.address}: ${total} esemény az elmúlt ~1 órában, ebből ${decoded} ETH-páros token`);
  }
}

const db = openDb(cfg.db.path);
const rows = db.prepare("SELECT chain, launchpad, COUNT(*) n, MIN(discovered_at) first, MAX(discovered_at) last FROM tokens GROUP BY chain, launchpad").all() as
  { chain: string; launchpad: string; n: number; first: number; last: number }[];
console.log("\n== DB tokens tábla");
if (rows.length === 0) console.log("   (üres – indítsd a botot `npm start`-tal és várj ~1 órát)");
for (const r of rows) console.log(`   ${r.chain}/${r.launchpad}: ${r.n} token (${new Date(r.first).toISOString()} … ${new Date(r.last).toISOString()})`);
const recent = db.prepare("SELECT chain, launchpad, symbol, address, discovered_block FROM tokens ORDER BY id DESC LIMIT 10").all() as Record<string, unknown>[];
for (const r of recent) console.log(`   ${r.chain}/${r.launchpad} ${r.symbol ?? "?"} ${r.address} @${r.discovered_block}`);
db.close();
