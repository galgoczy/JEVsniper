/**
 * BNB Chain / Four.Meme ellenőrző (csak olvas): npm run verify:bnb [-- --blocks 600]
 * - van-e kód a hivatalos címeken (TokenManager2, Helper3, PancakeSwap v2 Factory/Router, Chainlink BNB/USD)
 * - jönnek-e és dekódolhatók-e a TokenManager2 események a hivatalos ABI-val (TokenCreate/Purchase/Sale/TradeStop/LiquidityAdded)
 * - egy friss token getTokenInfo-ja (Helper3), és graduációnál melyik DEX-gyár eseménye van ugyanabban a tx-ben
 * RPC: BNB_RPC_URL a .env-ben, különben a publicnode publikus végpontja (a bnbchain.org dataseed végpontjai nem adnak getLogs-ot).
 */
import "dotenv/config";
import { createPublicClient, http, decodeEventLog, formatEther, getAddress, parseAbi } from "viem";
import { bsc } from "viem/chains";
import { fourMemeTokenManager2Abi, fourMemeHelper3Abi } from "../src/abis/fourmeme.js";

const TM2 = getAddress("0x5c952063c7fc8610FFDB798152D69F0B9550762b");      // docs/integration-guide.md 2.1
const H3 = getAddress("0xF251F83e40a78868FcfA3FA4599Dad6494E46034");       // docs/integration-guide.md 2.1
const PCS_V2_FACTORY = getAddress("0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73"); // developer.pancakeswap.finance/contracts/v2/addresses
const PCS_V2_ROUTER = getAddress("0x10ED43C718714eb63d5aA57B78B54704E256024E");  // ugyanott
const CL_BNB_USD = getAddress("0xd5D290Fe2ae6b55F385ab9C14d2CeB91DD3d9022");     // Chainlink reference-data-directory feeds-bsc-mainnet (BNB / USD proxy)

const rpc = (process.env.BNB_RPC_URL ?? "https://bsc-rpc.publicnode.com").split(",")[0]!.trim();
const c = createPublicClient({ chain: bsc, transport: http(rpc, { timeout: 15_000 }) });
const i = process.argv.indexOf("--blocks"); const span = BigInt(i >= 0 ? process.argv[i + 1]! : "600");
const ok = (m: string) => console.log("✅ " + m), bad = (m: string) => console.log("❌ " + m);

for (const [n, a] of [["TokenManager2", TM2], ["Helper3", H3], ["PancakeSwap v2 Factory", PCS_V2_FACTORY], ["PancakeSwap v2 Router", PCS_V2_ROUTER], ["Chainlink BNB/USD", CL_BNB_USD]] as const) {
  const code = await c.getCode({ address: a }); (code && code.length > 2 ? ok : bad)(`${n} ${a}: ${code ? (code.length - 2) / 2 : 0} bájt kód`);
}
const wbnb = await c.readContract({ address: PCS_V2_ROUTER, abi: parseAbi(["function WETH() view returns (address)"]), functionName: "WETH" });
ok(`PancakeSwap v2 Router WETH() = ${wbnb} (WBNB)`);
const clAbi = parseAbi(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)"]);
const [rd, dec] = await Promise.all([c.readContract({ address: CL_BNB_USD, abi: clAbi, functionName: "latestRoundData" }), c.readContract({ address: CL_BNB_USD, abi: clAbi, functionName: "decimals" })]);
ok(`BNB/USD = ${(Number(rd[1]) / 10 ** dec).toFixed(2)} (feed: ${dec} tizedes, frissítve ${Math.round((Date.now() / 1000 - Number(rd[3])) / 60)} perce)`);

const head = await c.getBlockNumber();
const counts: Record<string, number> = {};
const created: Array<{ token: string; name: string; symbol: string; block: bigint }> = [];
const grads: Array<{ token: string; quote: string; funds: bigint; tx: `0x${string}` }> = [];
let quotes = { bnb: 0, other: 0 };
for (let f = head - span; f <= head; f += 100n) {
  const to = f + 99n > head ? head : f + 99n;
  const logs = await c.getLogs({ address: TM2, fromBlock: f, toBlock: to });
  for (const l of logs) {
    try {
      const d = decodeEventLog({ abi: fourMemeTokenManager2Abi, data: l.data, topics: l.topics });
      counts[d.eventName] = (counts[d.eventName] ?? 0) + 1;
      const a = d.args as Record<string, unknown>;
      if (d.eventName === "TokenCreate") created.push({ token: String(a.token), name: String(a.name), symbol: String(a.symbol), block: l.blockNumber! });
      if (d.eventName === "LiquidityAdded") { grads.push({ token: String(a.base), quote: String(a.quote), funds: a.funds as bigint, tx: l.transactionHash! }); if (/^0x0+$/.test(String(a.quote))) quotes.bnb++; else quotes.other++; }
    } catch { counts["(dokumentálatlan, 1 szavas díj-esemény)"] = (counts["(dokumentálatlan, 1 szavas díj-esemény)"] ?? 0) + 1; }
  }
}
const secs = Number(span) * 0.75; // BSC ~0,75 mp blokkidő (ellenőrizzük lent)
const b0 = await c.getBlock({ blockNumber: head - span }), b1 = await c.getBlock({ blockNumber: head });
const realSecs = Number(b1.timestamp - b0.timestamp) || secs;
ok(`${span} blokk (${(realSecs / 60).toFixed(1)} perc, ${(realSecs / Number(span)).toFixed(2)} mp/blokk) események: ${JSON.stringify(counts)}`);
ok(`becsült tempó: ~${Math.round(((counts.TokenCreate ?? 0) / realSecs) * 86400)} új token/nap, ~${Math.round(((counts.LiquidityAdded ?? 0) / realSecs) * 86400)} graduáció/nap; graduációk quote: BNB ${quotes.bnb}, egyéb ${quotes.other}`);

if (created.length) {
  const t = created[created.length - 1]!;
  const info = await c.readContract({ address: H3, abi: fourMemeHelper3Abi, functionName: "getTokenInfo", args: [getAddress(t.token)] }) as readonly unknown[];
  ok(`friss token ${t.symbol} (${t.token}): version=${info[0]}, quote=${info[2]}, funds=${formatEther(info[9] as bigint)} / maxFunds=${formatEther(info[10] as bigint)}, díj=${Number(info[4]) / 100}%, liquidityAdded=${info[11]}`);
}
for (const g of grads.slice(0, 3)) {
  const r = await c.getTransactionReceipt({ hash: g.tx });
  const pc = r.logs.filter((l) => l.address.toLowerCase() === PCS_V2_FACTORY.toLowerCase());
  const others = [...new Set(r.logs.map((l) => l.address.toLowerCase()))].length;
  (pc.length ? ok : bad)(`graduáció ${g.token}: funds ${formatEther(g.funds)} ${/^0x0+$/.test(g.quote) ? "BNB" : g.quote}; PancakeSwap v2 Factory esemény a tx-ben: ${pc.length} (összes kibocsátó cím: ${others})`);
}
if (!grads.length) console.log("ℹ️  ebben az ablakban nem volt graduáció – nagyobb ablak: -- --blocks 3000");
