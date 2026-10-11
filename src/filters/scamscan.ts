import { type Address, type PublicClient, getAddress, parseAbiItem, isAddressEqual } from "viem";
import { ADDRESSES } from "../chains/addresses.js";

/**
 * Base csalásszűrő (2026-10-11). Az élő tapasztalat: minden élő veszteség csalásból jött (BNB: honeypot, címtiltás,
 * reaktív kihúzás; Base: a 0xe264-család – tárcafarmos áremelés, a kívülről vevők célzott elégetése). Három jel,
 * mind CSAK a belépés pillanatáig ismert adatból (nincs utólagos tudás):
 *  1) kód: a token bájtkódjába égetett, nem infrastruktúra cím (PUSH20) – kiváltságos „üzemeltető” (a 0xe264 így ült a kódban);
 *  2) vevők: a vételek zöme egyetlen ismeretlen szerződésen át, 0 ETH értékkel megy (a vételt a szerződés pénze fizeti → farm);
 *  3) kényszerített átutalás: valakinek a tokenje úgy mozdult, hogy nem ő küldte a tx-et, és nem ismert router/Permit2 vitte (égetés, elvétel).
 * Az eredmény a base_scam_checks táblába kerül; az élő vétel előtt kötelező kapu, az árnyékban szűrt nézet.
 */

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const DEAD = getAddress("0x000000000000000000000000000000000000dEaD");

/** Infrastruktúra-címek, amelyek egy tisztességes token kódjában is előfordulhatnak (nem „üzemeltető”). */
export function infraAddresses(): Set<string> {
  const A = ADDRESSES.base;
  const list = [A.weth, A.uniswapV4PoolManager, A.universalRouter, A.permit2, A.uniswapV2Factory, A.uniswapV3Factory, A.clankerV4Factory, A.v4Quoter, DEAD,
    "0x0000000000000000000000000000000000000000", "0xffffffffffffffffffffffffffffffffffffffff"];
  return new Set(list.filter(Boolean).map((a) => (a as string).toLowerCase()));
}

/** A bájtkódba égetett 20 bájtos konstansok (PUSH20 = 0x73), az utasítás-határokat követve (a PUSH-adatot átugorja). */
export function embeddedAddresses(codeHex: string): string[] {
  const code = codeHex.startsWith("0x") ? codeHex.slice(2) : codeHex;
  const out = new Set<string>();
  for (let i = 0; i < code.length; i += 2) {
    const op = parseInt(code.slice(i, i + 2), 16);
    if (op === 0x73) { out.add("0x" + code.slice(i + 2, i + 42).toLowerCase()); i += 40; }
    else if (op >= 0x60 && op <= 0x7f) i += (op - 0x5f) * 2;
  }
  return [...out];
}

/** Hihető cím-e (nem ASCII-szöveg-töredék, nem kis szám): a hibaüzenet-szövegek is PUSH20-ként kerülhetnek a kódba. */
export function looksLikeAddress(a: string): boolean {
  const h = a.slice(2);
  if (h.length !== 40) return false;                                           // a kód végén csonka (metaadat-) töredék
  if (h.includes("736f6c6343") || h.includes("6970667358")) return false;     // solc / ipfs metaadat („solcC”, „ipfsX”)
  if (h.startsWith("58221220")) return false;                                // ipfs-hash eleje a metaadatban (0x58 0x22 0x12 0x20)
  if (/^4200000000000000000000000000000000000[0-9a-f]{3}$/.test(h)) return false; // OP-stack rendszerszerződések (pl. 0x4200…0028 SuperchainTokenBridge)
  if (/^0+/.test(h) && h.replace(/^0+/, "").length < 30) return false;           // kis szám (pl. 0x…081c0033 – metaadat)
  const bytes = h.match(/../g)!.map((b) => parseInt(b, 16));
  const printable = bytes.filter((b) => b >= 0x20 && b <= 0x7e).length;
  return printable < 16;                                                       // ≥16 nyomtatható bájt → szöveg (pl. „ balanceERC20: trans”)
}

export function operatorAddresses(codeHex: string, infra = infraAddresses()): string[] {
  return embeddedAddresses(codeHex).filter((a) => !infra.has(a) && looksLikeAddress(a));
}

export interface ScamScan {
  embedded: string[];            // kódba égetett, nem infrastruktúra címek
  buys: number;                  // vizsgált vételi tx-ek (a poolból kijövő Transfer, belépésig)
  topRouter: string | null;      // a leggyakoribb vételi tx.to
  topRouterShare: number | null; // ennek aránya
  topRouterValue0: number | null;// ezen belül a 0 ETH értékű tx-ek aránya (natív ETH-páros poolnál ez farm-jel)
  topRouterEmbedded: boolean;    // a leggyakoribb router a kódba van égetve
  forced: number;                // kényszerített átutalások száma (belépésig)
  flags: string[];               // a kiváltott jelek (üres = tiszta)
}

/** Döntés a jelekből. Szigorú, de egyszerű: bármelyik erős jel → nem tiszta. */
export function scamFlags(s: Omit<ScamScan, "flags">, marked: Set<string> = new Set()): string[] {
  const f: string[] = [];
  if (s.embedded.some((a) => marked.has(a))) f.push("marked_operator");     // ismert (tanult) üzemeltető-cím a kódban
  if (s.embedded.length) f.push("embedded_operator");
  if (s.buys >= 8 && (s.topRouterShare ?? 0) >= 0.5 && (s.topRouterValue0 ?? 0) >= 0.8 && s.topRouter !== ADDRESSES.base.universalRouter?.toLowerCase()) f.push("farm_router");
  if (s.topRouterEmbedded) f.push("router_in_code");
  if (s.forced > 0) f.push("forced_transfer");
  return f;
}

/**
 * Vizsgálat a [fromBlock, toBlock] tartományban (indulás → belépés). A getLogs-ot kis szeletekben kéri (a publikus RPC-k
 * blokk-tartomány korlátja miatt), legfeljebb `maxTx` vételi tx-et néz meg részletesen.
 */
export async function scanToken(c: PublicClient, token: Address, fromBlock: bigint, toBlock: bigint, opts: { maxTx?: number; step?: bigint; marked?: Set<string>; codeAt?: bigint } = {}): Promise<ScamScan> {
  const PM = getAddress(ADDRESSES.base.uniswapV4PoolManager!);
  const code = (await c.getCode({ address: token, ...(opts.codeAt ? { blockNumber: opts.codeAt } : {}) })) ?? "0x";
  const embedded = operatorAddresses(code);
  const step = opts.step ?? 400n;
  const logs: Array<{ from: Address; to: Address; tx: `0x${string}` }> = [];
  for (let b = fromBlock; b <= toBlock; b += step) {
    const to = b + step - 1n < toBlock ? b + step - 1n : toBlock;
    let got = false;
    for (let k = 0; k < 6 && !got; k++) {
      try { for (const l of await c.getLogs({ address: token, event: TRANSFER, fromBlock: b, toBlock: to })) logs.push({ from: l.args.from!, to: l.args.to!, tx: l.transactionHash! }); got = true; }
      catch { await new Promise((r) => setTimeout(r, 700 * (k + 1))); }
    }
    if (!got) throw new Error(`getLogs sikertelen ${b}-${to}`);
  }
  const buyTx = [...new Set(logs.filter((l) => isAddressEqual(l.from, PM)).map((l) => l.tx))].slice(0, opts.maxTx ?? 30);
  const routers = new Map<string, { n: number; v0: number }>();
  await Promise.all(buyTx.map(async (h) => {
    const tx = await c.getTransaction({ hash: h });
    const r = (tx.to ?? "0x").toLowerCase(), e = routers.get(r) ?? { n: 0, v0: 0 };
    e.n++; if (tx.value === 0n) e.v0++; routers.set(r, e);
  }));
  // kényszerített átutalás: egy tulajdonos tokenje égetésbe (0xdEaD / 0x0) vagy a kódba égetett címre kerül úgy, hogy NEM ő küldte a tx-et,
  // és nem a pool / router / Permit2 mozgatta. A telepítő tx (tx.to = null) és a token saját mozgásai kimaradnak.
  const okMovers = new Set([PM, ADDRESSES.base.universalRouter, ADDRESSES.base.permit2].filter(Boolean).map((a) => (a as string).toLowerCase()));
  const ZERO = "0x0000000000000000000000000000000000000000";
  const suspects = logs.filter((l) => !isAddressEqual(l.from, PM) && l.from !== ZERO && !isAddressEqual(l.from, token) && !okMovers.has(l.from.toLowerCase())
    && (isAddressEqual(l.to, DEAD) || l.to === ZERO || embedded.includes(l.to.toLowerCase())));
  let forced = 0;
  const seenTx = new Map<string, { from: string; to: string | null }>();
  for (const l of suspects.slice(0, 20)) {
    let tx = seenTx.get(l.tx);
    if (!tx) { const t = await c.getTransaction({ hash: l.tx }); tx = { from: t.from.toLowerCase(), to: t.to ? t.to.toLowerCase() : null }; seenTx.set(l.tx, tx); }
    if (tx.to && tx.from !== l.from.toLowerCase() && !okMovers.has(tx.to)) forced++;
  }
  const top = [...routers].sort((a, b) => b[1].n - a[1].n)[0];
  const base = { embedded, buys: buyTx.length, topRouter: top?.[0] ?? null, topRouterShare: top ? top[1].n / buyTx.length : null,
    topRouterValue0: top ? top[1].v0 / top[1].n : null, topRouterEmbedded: !!top && embedded.includes(top[0]), forced };
  return { ...base, flags: scamFlags(base, opts.marked) };
}
