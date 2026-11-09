/**
 * Solana / Pump.fun ellenőrző (csak olvas): npm run verify:sol [-- --secs 30]
 * - a Pump program és a Global fiók létezik (getAccountInfo; a program executable)
 * - websocket-feliratkozás a programra N mp-re, események dekódolása a hivatalos IDL szerint, tempó-becslés
 */
import "dotenv/config";
import { PUMP_PROGRAM, PUMP_GLOBAL, PUMP_AMM_PROGRAM, SOL_DEFAULT_RPC, SOL_DEFAULT_WS, eventsFromLogs, curveProgressPct } from "../src/sol/pump.js";

const rpc = process.env.SOL_RPC_URL ?? SOL_DEFAULT_RPC, ws = (process.env.SOL_WS_URL || SOL_DEFAULT_WS).split(",")[0]!.trim();
const i = process.argv.indexOf("--secs"); const SECS = Number(i >= 0 ? process.argv[i + 1] : 30);
const ok = (m: string) => console.log("✅ " + m), bad = (m: string) => console.log("❌ " + m);
const call = async (method: string, params: unknown[]) => { const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); return ((await r.json()) as { result?: unknown; error?: unknown }); };
for (const [n, a, exec] of [["Pump program", PUMP_PROGRAM, true], ["Pump Global", PUMP_GLOBAL, false], ["PumpSwap AMM program", PUMP_AMM_PROGRAM, true]] as const) {
  const r = (await call("getAccountInfo", [a, { encoding: "base64" }])).result as { value: { executable: boolean; owner: string; data: [string, string] } | null } | undefined;
  const v = r?.value; (v && v.executable === exec ? ok : bad)(`${n} ${a}: ${v ? `létezik, executable=${v.executable}, ${Buffer.from(v.data[0], "base64").length} bájt` : "NINCS"}`);
}
const stats = { msgs: 0, create: 0, trade: 0, buys: 0, sells: 0, sol: 0, complete: 0, migrate: 0 };
const mints = new Map<string, { buyers: Set<string>; creator: string | null; created: boolean; maxProg: number }>();
const sock = new WebSocket(ws); const t0 = Date.now();
sock.onopen = () => sock.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [PUMP_PROGRAM] }, { commitment: "processed" }] }));
sock.onmessage = (m) => {
  const d = JSON.parse(String(m.data)) as { params?: { result?: { value?: { logs?: string[]; err?: unknown } } } }; const v = d.params?.result?.value; if (!v?.logs || v.err) return; stats.msgs++;
  for (const e of eventsFromLogs(v.logs)) {
    if (e.kind === "create") { stats.create++; mints.set(e.mint, { buyers: new Set(), creator: e.creator, created: true, maxProg: 0 }); }
    else if (e.kind === "trade") { stats.trade++; e.isBuy ? stats.buys++ : stats.sells++; stats.sol += Number(e.solAmount) / 1e9; let x = mints.get(e.mint); if (!x) { x = { buyers: new Set(), creator: null, created: false, maxProg: 0 }; mints.set(e.mint, x); } if (e.isBuy && e.user !== x.creator) x.buyers.add(e.user); x.maxProg = Math.max(x.maxProg, curveProgressPct(e.realTokenReserves)); }
    else if (e.kind === "complete") stats.complete++; else stats.migrate++;
  }
};
sock.onerror = () => bad("websocket hiba");
setTimeout(() => {
  sock.close(); const s = (Date.now() - t0) / 1000;
  ok(`${s.toFixed(0)} mp websocket: ${stats.msgs} tranzakció; create ${stats.create}, trade ${stats.trade} (vétel ${stats.buys} / eladás ${stats.sells}), complete ${stats.complete}, migráció ${stats.migrate}`);
  ok(`tempó: ~${Math.round(stats.create / s * 86400)} új token/nap, ~${Math.round(stats.trade / s * 86400)} kötés/nap, ~${Math.round(stats.sol / s * 86400)} SOL/nap, ~${Math.round(stats.complete / s * 86400)} görbe-teljesülés/nap`);
  const all = [...mints.values()]; const cr = all.filter((m) => m.created);
  ok(`ablakban indult ${cr.length} token külső vevői: 0: ${cr.filter((m) => !m.buyers.size).length}, 1-2: ${cr.filter((m) => m.buyers.size >= 1 && m.buyers.size <= 2).length}, 3+: ${cr.filter((m) => m.buyers.size >= 3).length}; kereskedett token ${all.length}, ebből görbe ≥50%: ${all.filter((m) => m.maxProg >= 50).length}`);
  process.exit(0);
}, SECS * 1000);
