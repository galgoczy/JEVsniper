import { type Address, type PublicClient, getAddress } from "viem";
import type { DB } from "../db/index.js";
import { nowMs } from "../db/index.js";
import type { Config } from "../config.js";
import type { ChainKey } from "../chains/index.js";
import { ADDRESSES } from "../chains/addresses.js";
import { ponsCurveAbi } from "../abis/pons.js";
import { uniswapV4SwapAbi, transferEventAbi } from "../abis/pools.js";
import { priceFromSqrtX96, v4IsBuy, v4TraderFromTransfers, type TransferRec } from "../collector/stats.js";
import { computePoolId, type PoolKey } from "../exec/routes.js";
import { scoreWallets, type WalletScore } from "./scoring.js";
import type { TokenRow } from "../collector/index.js";
import { log } from "../logger.js";

/**
 * Copy trading árnyékteszt – tárcakövető láncenként.
 *  1) A „követett kör”: az utolsó `universe_hours` órában felfedezett, kemény szűrőn átment (van döntés) tokenek,
 *     amelyek kereskedhetők (PONS curve, vagy v4 PoolKey-jel).
 *  2) Minden vételt/eladást tárcánként ment (wallet_trades): PONS-nál a CurveBuy/CurveSell (recipient/seller),
 *     v4-nél a PoolManager Swap + ugyanazon tx token-Transferje (a Swap sendere a router, nem a tárca).
 *  3) Tárcapontozás 10 percenként (scoring.ts), csak a már megtörtént kereskedésekből.
 *  4) Ha egy „smart” tárca vesz → copy_smart árnyékpozíció a mostani áron; „unskilled” tárca → copy_unskilled
 *     (kontroll: ugyanúgy tapasztalt kereskedő, ugyanabban a tokenkörben, de nem nyerő).
 * Minden belépés árnyék (dry), a meglévő kilépési tervekkel; tokenenként és karonként egyszer.
 */
export interface CopyDeps {
  db: DB; cfg: Config; chain: ChainKey; client: PublicClient;
  ethUsd: () => Promise<number | "unknown">;
  openShadow: (t: TokenRow, arm: string, price: number, ethUsd: number, liquidityNative: number | null) => number;
}

interface Trade { tokenId: number; wallet: string; isBuy: boolean; native: number; tokens: number; block: bigint; tx: string; price: number | null; liq: number | null }

export class CopyTracker {
  private lastBlock: bigint | null = null;
  private scores = new Map<string, WalletScore>();
  private scoredAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  stats = { polls: 0, trades: 0, signals: 0, errors: 0 };

  constructor(private d: CopyDeps) {}

  start() {
    const c = this.d.cfg.copy;
    if (!c.enabled) return;
    this.timer = setInterval(() => void this.tick().catch((e) => { this.stats.errors++; log.warn(`copy tracker hiba (${this.d.chain})`, { error: (e as Error).message.slice(0, 160) }); }), c.poll_interval_ms);
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  universe(): TokenRow[] {
    const since = nowMs() - this.d.cfg.copy.universe_hours * 3_600_000;
    return (this.d.db.prepare(`SELECT t.* FROM tokens t WHERE t.chain = ? AND t.discovered_at > ? AND EXISTS (SELECT 1 FROM decisions d WHERE d.token_id = t.id)`)
      .all(this.d.chain, since) as TokenRow[]).filter((t) => this.poolIdOf(t) !== null || this.curveOf(t) !== null);
  }
  private curveOf(t: TokenRow): Address | null { return t.mechanics === "bonding_curve" && !t.graduated_at && t.pool_address && /^0x[0-9a-fA-F]{40}$/.test(t.pool_address) ? getAddress(t.pool_address) : null; }
  private poolIdOf(t: TokenRow): `0x${string}` | null {
    if ((t.mechanics === "v4" || t.mechanics === "v4_hook") && t.pool_key_json && t.pool_address?.length === 66) return t.pool_address as `0x${string}`;
    if (t.mechanics === "bonding_curve" && t.graduated_at && t.pool_key_json) return computePoolId(JSON.parse(t.pool_key_json) as PoolKey);
    return null;
  }

  async tick(): Promise<void> {
    if (this.busy) return; this.busy = true;
    try {
      const { client } = this.d;
      const head = await client.getBlockNumber();
      const from = this.lastBlock === null ? head - 20n : this.lastBlock + 1n;
      if (head < from) return;
      const to = head - from > 2000n ? from + 2000n : head; // felzárkózás darabokban
      const uni = this.universe();
      if (uni.length) {
        const trades = [...await this.curveTrades(uni, from, to), ...await this.v4Trades(uni, from, to)];
        this.save(trades);
        await this.signals(uni, trades);
      }
      this.lastBlock = to; this.stats.polls++;
    } finally { this.busy = false; }
  }

  private async curveTrades(uni: TokenRow[], from: bigint, to: bigint): Promise<Trade[]> {
    const curves = uni.map((t) => ({ t, c: this.curveOf(t) })).filter((x): x is { t: TokenRow; c: Address } => x.c !== null);
    const byCurve = new Map(curves.map((x) => [x.c.toLowerCase(), x.t]));
    const ev = ponsCurveAbi.filter((x) => x.type === "event" && (x.name === "CurveBuy" || x.name === "CurveSell"));
    const out: Trade[] = [];
    for (let i = 0; i < curves.length; i += 200) {
      const logs = await this.d.client.getLogs({ address: curves.slice(i, i + 200).map((x) => x.c), events: ev as never, fromBlock: from, toBlock: to }) as unknown as Array<{ address: string; eventName: string; args: Record<string, unknown>; blockNumber: bigint; transactionHash: string }>;
      for (const l of logs) {
        const t = byCurve.get(l.address.toLowerCase()); if (!t) continue;
        const isBuy = l.eventName === "CurveBuy", dec = t.decimals ?? 18;
        const native = Number((isBuy ? l.args.quoteIn : l.args.quoteOut) as bigint) / 1e18;
        const tokens = Number((isBuy ? l.args.tokensOut : l.args.tokensIn) as bigint) / 10 ** dec;
        const wallet = String(isBuy ? l.args.recipient : l.args.seller);
        out.push({ tokenId: t.id, wallet, isBuy, native, tokens, block: l.blockNumber, tx: l.transactionHash, price: tokens > 0 ? native / tokens : null, liq: null });
      }
    }
    return out;
  }

  private async v4Trades(uni: TokenRow[], from: bigint, to: bigint): Promise<Trade[]> {
    const pm = ADDRESSES[this.d.chain].uniswapV4PoolManager;
    if (!pm) return [];
    const pools = uni.map((t) => ({ t, id: this.poolIdOf(t) })).filter((x): x is { t: TokenRow; id: `0x${string}` } => x.id !== null);
    const byId = new Map(pools.map((x) => [x.id.toLowerCase(), x.t]));
    const out: Trade[] = [];
    for (let i = 0; i < pools.length; i += 200) {
      const chunk = pools.slice(i, i + 200);
      const swaps = await this.d.client.getLogs({ address: pm, event: uniswapV4SwapAbi[0], args: { id: chunk.map((x) => x.id) }, fromBlock: from, toBlock: to });
      if (!swaps.length) continue;
      // a tárca a token Transfer-eseményből (ugyanabban a tx-ben): PoolManager → tárca (vétel), tárca → PoolManager (eladás)
      const tokens = [...new Set(swaps.map((s) => byId.get((s.args.id as string).toLowerCase())?.address).filter(Boolean))] as Address[];
      const [inT, outT] = await Promise.all([
        this.d.client.getLogs({ address: tokens, event: transferEventAbi[0], args: { from: pm }, fromBlock: from, toBlock: to }),
        this.d.client.getLogs({ address: tokens, event: transferEventAbi[0], args: { to: pm }, fromBlock: from, toBlock: to }),
      ]);
      const recs: TransferRec[] = [...inT, ...outT].map((l) => ({ from: l.args.from!, to: l.args.to!, value: l.args.value!, block: l.blockNumber!, tx: l.transactionHash ?? undefined }));
      const traders = v4TraderFromTransfers(recs, pm);
      for (const s of swaps) {
        const t = byId.get((s.args.id as string).toLowerCase()); if (!t) continue;
        const pair = (t.pair_token ?? "0x0000000000000000000000000000000000000000") as Address;
        const tokenIsC0 = BigInt(t.address) < BigInt(pair), dec = t.decimals ?? 18;
        const tokenAmt = tokenIsC0 ? s.args.amount0! : s.args.amount1!, quoteAmt = tokenIsC0 ? s.args.amount1! : s.args.amount0!;
        const isBuy = v4IsBuy(tokenAmt);
        const tr = s.transactionHash ? traders.get(s.transactionHash) : undefined;
        const wallet = isBuy ? tr?.buyer : tr?.seller;
        if (!wallet || !s.transactionHash) continue; // tárca nélkül nem követhető
        out.push({ tokenId: t.id, wallet, isBuy, native: Math.abs(Number(quoteAmt)) / 1e18, tokens: Math.abs(Number(tokenAmt)) / 10 ** dec, block: s.blockNumber!, tx: s.transactionHash,
          price: priceFromSqrtX96(s.args.sqrtPriceX96!, tokenIsC0, dec), liq: null }); // v4: a virtuális tartalék félrevezető – a monitor az első árfeed-értéket (valódi ETH) veszi alapnak
      }
    }
    return out;
  }

  private save(trades: Trade[]) {
    if (!trades.length) return;
    const ins = this.d.db.prepare("INSERT OR IGNORE INTO wallet_trades(chain, token_id, wallet, is_buy, native, tokens, block, at, tx_hash) VALUES (?,?,?,?,?,?,?,?,?)");
    const now = nowMs();
    this.d.db.transaction(() => { for (const t of trades) this.stats.trades += ins.run(this.d.chain, t.tokenId, t.wallet.toLowerCase(), t.isBuy ? 1 : 0, t.native, t.tokens, Number(t.block), now, t.tx).changes; })();
  }

  private refreshScores() {
    const c = this.d.cfg.copy;
    if (Date.now() - this.scoredAt < c.score_refresh_min * 60_000) return;
    this.scores = scoreWallets(this.d.db, this.d.chain, { minClosed: c.min_closed_tokens, minWinRate: c.min_win_rate });
    this.scoredAt = Date.now();
  }

  /** Jelzések: a kör tokenjeiben egy minősített tárca vett (legalább min_buy_native) → árnyék-belépés az utolsó áron. */
  private async signals(uni: TokenRow[], trades: Trade[]) {
    this.refreshScores();
    const c = this.d.cfg.copy;
    const buys = trades.filter((t) => t.isBuy && t.native >= c.min_buy_native);
    if (!buys.length) return;
    const eth = await this.d.ethUsd();
    if (typeof eth !== "number") return;
    const byId = new Map(uni.map((t) => [t.id, t]));
    // tokenenként az utolsó ismert ár (a jelzés utáni, tehát a másolt vétel UTÁNI ár – óvatos)
    const last = new Map<number, Trade>();
    for (const t of trades) if (t.price !== null) last.set(t.tokenId, t);
    for (const b of buys) {
      const s = this.scores.get(b.wallet.toLowerCase());
      if (!s?.cls) continue;
      const arm = s.cls === "smart" ? "copy_smart" : "copy_unskilled";
      const t = byId.get(b.tokenId); const lp = last.get(b.tokenId);
      if (!t || !lp?.price) continue;
      let price = lp.price, liq = lp.liq;
      const curve = this.curveOf(t);
      if (curve) { // PONS curve: a kereskedés átlagára optimista → a vétel utáni határár és likviditás a tartalékokból
        const [q, tk] = await Promise.all([
          this.d.client.readContract({ address: curve, abi: ponsCurveAbi, functionName: "quoteReserve" }).catch(() => null) as Promise<bigint | null>,
          this.d.client.readContract({ address: curve, abi: ponsCurveAbi, functionName: "tokenReserve" }).catch(() => null) as Promise<bigint | null>,
        ]);
        if (q === null || tk === null || tk === 0n) continue;
        price = Number(q) / Number(tk) * 10 ** ((t.decimals ?? 18) - 18); liq = Number(q) / 1e18;
      }
      if (this.d.openShadow(t, arm, price, eth, liq) > 0) { this.stats.signals++; log.info(`Copy jelzés: ${arm}`, { token: t.symbol, wallet: b.wallet, closed: s.closed, wins: s.wins, pnl: s.pnl.toFixed(3) }); }
    }
  }
}
