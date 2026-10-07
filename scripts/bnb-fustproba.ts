/**
 * BNB füstpróba (2026-10-07): VALÓDI tranzakciók – ~1 USD BNB-ért vesz egy ismert, likvid tokent (alapból CAKE), jóváhagy, és
 * azonnal visszaadja, ugyanazon a végrehajtón, mint az élő kar. Bizonyítja, hogy a vétel/approve/eladás működik, méri a késést és a gázt.
 *   npx tsx scripts/bnb-fustproba.ts --igen [--usd 1] [--token 0x...]
 * A `--igen` nélkül csak kiírja, mit tenne. A kulcsot a viem account kezeli; nem íródik ki.
 */
import "dotenv/config";
import { getAddress } from "viem";
import { loadConfig } from "../src/config.js";
import { loadEnv } from "../src/env.js";
import { openDb } from "../src/db/index.js";
import { BnbLive } from "../src/bnb/live.js";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1]! : d; };
const usd = Number(arg("--usd", "1"));
// CAKE: PancakeSwap token (developer.pancakeswap.finance); on-chain ellenőrizve 2026-10-07 (symbol "Cake", WBNB-pár 0x0eD7…4fD0)
const token = getAddress(arg("--token", "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82"));
const go = process.argv.includes("--igen");
const cfg = loadConfig(), env = loadEnv({ requireWallet: true }), db = openDb(cfg.db.path);
db.pragma("busy_timeout = 30000");
const bnbUsd = () => { const r = db.prepare("SELECT value FROM meta WHERE key = 'bnb_usd'").get() as { value: string } | undefined; const v = Number(r?.value); return v > 0 ? v : null; };
// a füstpróbához a BNB-kapcsoló élő (csak ebben a folyamatban; a config.yaml-t nem írja át)
const live = new BnbLive({ db, cfg: { ...cfg, bnb_live: { ...cfg.bnb_live, mode: go ? "live" : "dry_run" } }, privateKey: env.WALLET_PRIVATE_KEY as `0x${string}`, rpcUrl: env.BNB_RPC_URL || undefined, bnbUsd, notify: async (m) => { console.log(m); } });
console.log(`tárca ${live.address}, token ${token}, ${usd} USD (${(usd / (bnbUsd() ?? 1)).toFixed(6)} BNB), BNB/USD ${bnbUsd()?.toFixed(2)}`);
if (!go) { console.log("próba (nincs tranzakció) – a valódi futtatáshoz: --igen"); process.exit(0); }
try { console.log(await live.smokeTest(token, usd)); } catch (e) { console.log("❌ " + (e as Error).message); process.exit(1); }
