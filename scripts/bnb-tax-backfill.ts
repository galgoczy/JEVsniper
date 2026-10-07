/**
 * BNB árnyék-pozíciók token-adójának visszamenőleges mérése (2026-10-07): a pár felvett kötéseinek nyugtáiból
 * (BNB Chain hivatalos végpont – a publicnode a régebbi nyugtát nem adja). Csak a még nem mért párokra.
 *   npx tsx scripts/bnb-tax-backfill.ts
 */
import "dotenv/config";
import { createPublicClient, http, type PublicClient } from "viem";
import { bsc } from "viem/chains";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { measureTax } from "../src/bnb/tax.js";
import { BNB_RECEIPT_RPC } from "../src/bnb/addresses.js";

const cfg = loadConfig(); const db = openDb(cfg.db.path);
db.pragma("busy_timeout = 30000");
const c = createPublicClient({ chain: bsc, transport: http(BNB_RECEIPT_RPC, { timeout: 15_000, retryCount: 1 }) }) as PublicClient;
const pairs = db.prepare(`SELECT DISTINCT s.pair, p.token, p.wbnb_is0 FROM bnb_shadow_positions s JOIN bnb_pairs p ON p.pair = s.pair WHERE s.buy_tax IS NULL OR s.sell_tax IS NULL`).all() as Array<{ pair: string; token: string; wbnb_is0: number }>;
let done = 0, measured = 0;
for (let i = 0; i < pairs.length; i += 6) {
  await Promise.all(pairs.slice(i, i + 6).map(async (p) => {
    const trades = db.prepare("SELECT tx, side FROM bnb_pair_trades WHERE pair = ? ORDER BY at DESC LIMIT 60").all(p.pair) as Array<{ tx: string; side: "buy" | "sell" }>;
    const r = await measureTax(c, p.pair, p.token, p.wbnb_is0 === 1, trades);
    done++;
    if (r.buyTax === null && r.sellTax === null) return;
    db.prepare("UPDATE bnb_shadow_positions SET buy_tax = COALESCE(?, buy_tax), sell_tax = COALESCE(?, sell_tax), tax_n = ? WHERE pair = ? AND (buy_tax IS NULL OR sell_tax IS NULL)").run(r.buyTax, r.sellTax, `${r.nBuy}/${r.nSell}`, p.pair);
    measured++;
  }));
}
console.log(`párok: ${pairs.length}, lekérdezve ${done}, mért ${measured}`);
