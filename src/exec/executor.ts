import { type Address, type Hex, type PublicClient, type WalletClient, createWalletClient, http, formatEther, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DB } from "../db/index.js";
import { nowMs, todayUtc, logEvent } from "../db/index.js";
import type { Config } from "../config.js";
import { CHAINS, type ChainKey } from "../chains/index.js";
import { erc20WriteAbi } from "../abis/uniswapV4.js";
import type { Route, TxRequest } from "./routes.js";
import { stopFileExists } from "../killswitch.js";
import { log } from "../logger.js";

export interface SendResult {
  ok: boolean; hash: Hex | null; nonce: number; gasUsed: bigint; gasCostWei: bigint; gasUsd: number | null;
  blockNumber: bigint | null; error: string | null; latencyMs: number; label: string;
}

export class GasCapError extends Error { constructor(msg: string) { super(msg); this.name = "GasCapError"; } }
export class StoppedError extends Error { constructor(msg: string) { super(msg); this.name = "StoppedError"; } }

/**
 * Végrehajtó egy láncra. Feladata: nonce (DB + lánc), gas-becslés és USD-plafon, küldés, nyugta, kitöltés-napló,
 * sikertelen tx egyszeri újrapróbálása, egymást követő hibák számlálása (kockázati korlát), STOP-fájl.
 * A privát kulcsot csak a viem account tartja, sehol nem naplózzuk.
 */
export class Executor {
  readonly account;
  readonly wallet: WalletClient;
  readonly address: Address;
  constructor(readonly chain: ChainKey, readonly client: PublicClient, private db: DB, private cfg: Config,
    privateKey: `0x${string}`, sendRpcUrl: string, private ethUsd: () => Promise<number | "unknown">) {
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
    // küldés külön transporton (privát/MEV-védett RPC, ha be van állítva), olvasás a közös kliensen
    this.wallet = createWalletClient({ account: this.account, chain: CHAINS[chain], transport: http(sendRpcUrl, { timeout: 15_000 }) });
  }

  get consecutiveFailed(): number {
    return (this.db.prepare("SELECT consecutive_failed_tx n FROM daily_state WHERE day = ?").get(todayUtc()) as { n: number } | undefined)?.n ?? 0;
  }
  private setFailed(n: number) {
    this.db.prepare("INSERT INTO daily_state(day, consecutive_failed_tx) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET consecutive_failed_tx = excluded.consecutive_failed_tx").run(todayUtc(), n);
  }

  /** Nonce: a lánc pending számlálója és a DB-ben tárolt következő nonce közül a nagyobb (újraindítás után is helyes). */
  async nextNonce(): Promise<number> {
    const onChain = await this.client.getTransactionCount({ address: this.address, blockTag: "pending" });
    const row = this.db.prepare("SELECT next_nonce FROM nonces WHERE chain = ?").get(this.chain) as { next_nonce: number } | undefined;
    return Math.max(onChain, row?.next_nonce ?? 0);
  }
  private saveNonce(next: number) {
    this.db.prepare("INSERT INTO nonces(chain, next_nonce, updated_at) VALUES (?,?,?) ON CONFLICT(chain) DO UPDATE SET next_nonce = excluded.next_nonce, updated_at = excluded.updated_at").run(this.chain, next, nowMs());
  }

  async gasUsd(gasWei: bigint): Promise<number | null> {
    const p = await this.ethUsd();
    return typeof p === "number" ? Number(formatEther(gasWei)) * p : null;
  }

  /**
   * Egy tranzakció: becslés → USD-plafon → küldés → nyugta. `isSell` esetén a magasabb (eladási) plafon él.
   * `bypassStop`: panic-eladásnál a STOP nem akadály (a kilépés fontosabb).
   */
  async send(tx: TxRequest, opts: { isSell?: boolean; bypassStop?: boolean; positionId?: number | null; kind?: string; isLive?: boolean; estPrice?: number | null } = {}): Promise<SendResult> {
    if (!opts.bypassStop && !opts.isSell && stopFileExists()) throw new StoppedError("STOP aktív – nincs új vétel");
    if (!opts.bypassStop && !opts.isSell && this.consecutiveFailed >= this.cfg.risk.max_consecutive_failed_tx) throw new StoppedError(`${this.consecutiveFailed} egymást követő sikertelen tx – kézi újraindítás kell (/resume)`);
    if (this.cfg.mode === "dry_run") throw new StoppedError("dry_run mód – nem küldünk tranzakciót");

    const started = nowMs();
    let gas: bigint, gasPrice: bigint;
    try {
      [gas, gasPrice] = await Promise.all([
        this.client.estimateGas({ account: this.account, to: tx.to, data: tx.data, value: tx.value }),
        this.client.getGasPrice(),
      ]);
    } catch (e) {
      // A szimuláció már revertál (pl. túl magas minOut, honeypot): nem küldünk, nem fizetünk gast, de sikertelenként naplózzuk.
      const error = "szimuláció revert: " + (e as Error).message.split("\n")[0]!.slice(0, 180);
      this.setFailed(this.consecutiveFailed + 1);
      const res: SendResult = { ok: false, hash: null, nonce: -1, gasUsed: 0n, gasCostWei: 0n, gasUsd: 0, blockNumber: null, error, latencyMs: nowMs() - started, label: tx.label };
      this.recordFill(res, tx, opts, null);
      log.warn(`tx ${tx.label} szimuláció sikertelen (${this.chain})`, { error });
      return res;
    }
    const estWei = gas * gasPrice;
    const estUsd = await this.gasUsd(estWei);
    const cap = opts.isSell ? this.cfg.risk.max_gas_per_sell_usd : this.cfg.risk.max_gas_per_tx_usd;
    if (estUsd !== null && estUsd > cap) throw new GasCapError(`becsült gas ${estUsd.toFixed(4)} USD > plafon ${cap} USD (${tx.label})`);

    const nonce = await this.nextNonce();
    let hash: Hex | null = null, receipt: TransactionReceipt | null = null, error: string | null = null;
    try {
      hash = await this.wallet.sendTransaction({ account: this.account, chain: CHAINS[this.chain], to: tx.to, data: tx.data, value: tx.value, gas: (gas * 12n) / 10n, nonce });
      this.saveNonce(nonce + 1);
      receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 90_000 });
      if (receipt.status !== "success") error = "reverted";
    } catch (e) {
      error = (e as Error).message.split("\n")[0]!.slice(0, 200);
      if (hash) this.saveNonce(nonce + 1);
    }
    const gasUsed = receipt?.gasUsed ?? 0n;
    const l1 = (receipt as unknown as { l1Fee?: bigint })?.l1Fee ?? 0n; // OP-stack (Base) L1 adatdíj, ha a nyugtában van
    const gasCostWei = gasUsed * (receipt?.effectiveGasPrice ?? gasPrice) + l1;
    const gasUsdReal = await this.gasUsd(gasCostWei);
    const ok = !error;
    this.setFailed(ok ? 0 : this.consecutiveFailed + 1);
    const res: SendResult = { ok, hash, nonce, gasUsed, gasCostWei, gasUsd: gasUsdReal, blockNumber: receipt?.blockNumber ?? null, error, latencyMs: nowMs() - started, label: tx.label };
    this.recordFill(res, tx, opts, estUsd);
    log[ok ? "info" : "warn"](`tx ${tx.label} ${ok ? "ok" : "HIBA"} (${this.chain})`, { hash, nonce, gasUsd: gasUsdReal, error });
    if (!ok && this.consecutiveFailed >= this.cfg.risk.max_consecutive_failed_tx) logEvent(this.db, "pause", `max_consecutive_failed_tx (${this.chain})`);
    return res;
  }

  private recordFill(r: SendResult, tx: TxRequest, opts: { positionId?: number | null; kind?: string; isLive?: boolean; estPrice?: number | null }, estGasUsd: number | null) {
    if (opts.positionId == null) return;
    this.db.prepare(`INSERT INTO fills(position_id, chain, kind, is_live, at, tx_hash, nonce, block_number, status, est_gas_usd, real_gas_usd, est_price_native, amount_in, error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(opts.positionId, this.chain, opts.kind ?? tx.label, opts.isLive === false ? 0 : 1, nowMs(), r.hash, r.nonce,
      r.blockNumber !== null ? Number(r.blockNumber) : null, r.ok ? "success" : "failed", estGasUsd, r.gasUsd, opts.estPrice ?? null, Number(formatEther(tx.value)), r.error);
  }

  /** Egyszeri újrapróbálás sikertelen tx után (config execution.retry_failed_tx_once). */
  async sendWithRetry(tx: TxRequest, opts: Parameters<Executor["send"]>[1] = {}): Promise<SendResult> {
    const r = await this.send(tx, opts);
    if (r.ok || !this.cfg.execution.retry_failed_tx_once) return r;
    log.warn(`újrapróbálás: ${tx.label}`);
    return this.send(tx, opts);
  }

  async tokenBalance(token: Address): Promise<bigint> {
    return this.client.readContract({ address: token, abi: erc20WriteAbi, functionName: "balanceOf", args: [this.address] });
  }
  /** Egyenleg egy tx után: a több publikus végpont közül egy lemaradt csomópont még a régi értéket adhatja → újrakérdezés, amíg változik (max ~4 mp). */
  async tokenBalanceAfter(token: Address, before: bigint, expectChange = true): Promise<bigint> {
    let b = before;
    for (let i = 0; i < 8; i++) {
      b = await this.tokenBalance(token);
      if (!expectChange || b !== before) return b;
      await new Promise((r) => setTimeout(r, 500));
    }
    return b;
  }
  async nativeBalance(): Promise<bigint> { return this.client.getBalance({ address: this.address }); }

  /** Vétel: árajánlat, slippage, küldés. Visszaadja a kapott tokenmennyiséget (balance-különbségből). */
  async buy(route: Route, token: Address, nativeIn: bigint, slippagePct: number, opts: { positionId?: number | null; bypassStop?: boolean } = {}) {
    const q = await route.quoteBuy(nativeIn, this.address);
    if (q.priceImpactPct !== undefined && q.priceImpactPct > this.cfg.execution.max_price_impact_pct) {
      throw new GasCapError(`árhatás ${q.priceImpactPct.toFixed(1)}% > ${this.cfg.execution.max_price_impact_pct}% (becsült likviditás ${q.estLiquidityNative?.toFixed(4)} ETH) – túl sekély pool, nincs vétel`);
    }
    const minOut = (q.amountOut * BigInt(Math.round((100 - slippagePct) * 100))) / 10000n;
    const before = await this.tokenBalance(token);
    const tx = route.buildBuy(nativeIn, minOut, this.address, this.cfg.execution.deadline_sec);
    const r = await this.sendWithRetry(tx, { positionId: opts.positionId, kind: "buy", bypassStop: opts.bypassStop, estPrice: Number(nativeIn) / Number(q.amountOut) });
    const after = r.ok ? await this.tokenBalanceAfter(token, before) : before;
    if (r.ok && after === before) log.warn("vétel sikeres, de a tokenegyenleg nem változott – nem szabványos token?", { token });
    return { ...r, quote: q, minOut, tokensReceived: after - before };
  }

  /**
   * Eladás: friss árajánlat (= eladás-szimuláció), lépcsőzetes slippage a plafonig (config panic_slippage_pct),
   * approve csak a szükséges mennyiségre. Sikertelen minden lépcsőn → "unsellable".
   */
  async sell(route: Route, token: Address, tokensIn: bigint, startSlippagePct: number, opts: { positionId?: number | null; panic?: boolean } = {}) {
    const maxSlip = this.cfg.execution.panic_slippage_pct;
    const ladder = opts.panic ? [maxSlip] : [startSlippagePct, Math.min(maxSlip, startSlippagePct * 2), maxSlip].filter((v, i, a) => a.indexOf(v) === i);
    let last: SendResult | null = null;
    if (tokensIn <= 0n) return { ok: false, hash: null, nonce: -1, gasUsed: 0n, gasCostWei: 0n, gasUsd: null, blockNumber: null, error: "nincs eladható tokenmennyiség", latencyMs: 0, label: "sell", quote: null, slippagePct: 0, nativeReceived: 0n, unsellable: true };
    for (const slip of ladder) {
      let q;
      try { q = await route.quoteSell(tokensIn); }
      catch (e) { last = { ok: false, hash: null, nonce: -1, gasUsed: 0n, gasCostWei: 0n, gasUsd: null, blockNumber: null, error: `sell-szimuláció sikertelen: ${(e as Error).message.slice(0, 120)}`, latencyMs: 0, label: "quoteSell" }; continue; }
      const minOut = (q.amountOut * BigInt(Math.round((100 - slip) * 100))) / 10000n;
      const txs = await route.buildSell(tokensIn, minOut, this.address, this.cfg.execution.deadline_sec, this.address);
      const before = await this.nativeBalance();
      const tokBefore = await this.tokenBalance(token);
      let failed = false;
      for (const tx of txs) {
        const r = await this.send(tx, { isSell: true, bypassStop: true, positionId: opts.positionId, kind: tx.label.startsWith("approve") || tx.label.startsWith("permit2") ? "approve" : "sell" });
        last = r;
        if (!r.ok) { failed = true; break; }
      }
      if (!failed && last) {
        await this.tokenBalanceAfter(token, tokBefore); // várjuk meg, míg a csomópont látja az eladást
        const after = await this.nativeBalance();
        return { ...last, quote: q, slippagePct: slip, nativeReceived: after - before + last.gasCostWei, unsellable: false };
      }
      log.warn(`eladás sikertelen ${slip}% csúszással, következő lépcső`, { token, error: last?.error });
    }
    return { ...(last as SendResult), quote: null, slippagePct: ladder.at(-1)!, nativeReceived: 0n, unsellable: true };
  }
}
