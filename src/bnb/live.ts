import { createPublicClient, createWalletClient, http, parseAbi, getAddress, formatEther, encodeFunctionData, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import type { DB } from "../db/index.js";
import { nowMs, todayUtc, logEvent } from "../db/index.js";
import type { Config } from "../config.js";
import { BNB, BNB_DEFAULT_RPC, BNB_RECEIPT_RPC } from "./addresses.js";
import { stopFileExists } from "../killswitch.js";
import { log } from "../logger.js";

/**
 * BNB / PancakeSwap ÉLŐ végrehajtó (2026-10-07, kis teszt). A BNB árnyékkar (config bnb_live.arm) jelzésére – az eladhatósági
 * próba után – valódi vétel, azonnali jóváhagyás (approve) a routernek, majd a fő terv (2× vagy −40% → minden; 6 óra; kiürülés)
 * szerinti eladás a felvevő körében látott áron. Ugyanaz a tárca, mint Base-en (a kulcsot csak a viem account tartja, nem naplózzuk).
 *  - Vétel: swapExactETHForTokensSupportingFeeOnTransferTokens (adós tokenekre is), minOut = jegyzett × (1 − buy_slippage).
 *  - Eladás: swapExactTokensForETHSupportingFeeOnTransferTokens a teljes egyenlegre; revert esetén pánik-csúszással újra, utána
 *    „unsellable” (honeypot) – ez a teszt egyik kérdése. Kiürült párba nem adunk el (nincs mit kapni).
 *  - Védelmek: csak mode=live ÉS enabled; STOP-fájl; egymást követő hibák (max_consecutive_failed → szünet, /resume);
 *    max_open; napi veszteségkorlát (USD); BNB-egyenleg ≥ pozíció + gáz-tartalék; gázplafon USD-ben; sekély pár (min_liq_bnb).
 *  - Gáz: legacy gasPrice = max(lánc, gas_gwei) – a BSC-n az ár szerinti sorrend számít, ez ~0,03 USD/tx.
 * dry_run-ban csak „BELÉPNE” Telegram-jelzés; tranzakció nem megy ki.
 */
const ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address spender, uint256 amount) returns (bool)", "function allowance(address owner, address spender) view returns (uint256)", "function decimals() view returns (uint8)"]);
const MAX_UINT = (1n << 256n) - 1n;
const HORIZON_MS = 6 * 3600_000, RUG_LIQ = 0.05;

interface Pos { id: number; pair: string; token: Address; arm: string; openedAt: number; spentBnb: number; spentUsd: number; tokens: bigint; entry: number; peak: number; phase: string; approved: boolean; sellAttempts: number; decimals: number }
export interface LiveDeps { db: DB; cfg: Config; privateKey: `0x${string}`; rpcUrl?: string; bnbUsd: () => number | null; notify: (m: string) => Promise<unknown>; client?: PublicClient; wallet?: WalletClient; receiptClient?: PublicClient; now?: () => number }

export class BnbLive {
  readonly address: Address;
  private account; private c: PublicClient; private rc: PublicClient; private w: WalletClient;
  private open = new Map<number, Pos>();
  private busy = new Set<number>();
  stats = { signals: 0, buys: 0, sells: 0, failed: 0, blocked: 0 };
  constructor(private d: LiveDeps) {
    this.account = privateKeyToAccount(d.privateKey); this.address = this.account.address;
    const url = (d.rpcUrl ?? BNB_DEFAULT_RPC).split(",")[0]!.trim();
    this.c = d.client ?? (createPublicClient({ chain: bsc, transport: http(url, { timeout: 15_000, retryCount: 1 }) }) as PublicClient);
    this.rc = d.receiptClient ?? (createPublicClient({ chain: bsc, transport: http(BNB_RECEIPT_RPC, { timeout: 15_000, retryCount: 1 }) }) as PublicClient);
    this.w = d.wallet ?? createWalletClient({ account: this.account, chain: bsc, transport: http(url, { timeout: 15_000 }) });
    this.restore();
  }
  private now() { return (this.d.now ?? Date.now)(); }
  private get L() { return this.d.cfg.bnb_live; }
  get openCount() { return this.open.size; }

  restore() {
    for (const r of this.d.db.prepare("SELECT * FROM bnb_live_positions WHERE closed_at IS NULL").all() as Array<Record<string, unknown>>)
      this.open.set(r.id as number, { id: r.id as number, pair: r.pair as string, token: getAddress(r.token as string), arm: r.arm as string, openedAt: r.opened_at as number, spentBnb: r.spent_bnb as number, spentUsd: r.spent_usd as number,
        tokens: BigInt(Math.round(r.tokens_left as number)), entry: r.entry_price as number, peak: (r.peak_price as number) ?? (r.entry_price as number), phase: r.phase as string, approved: (r.approved as number) === 1, sellAttempts: r.sell_attempts as number, decimals: 18 });
  }

  private failed(): number { return (this.d.db.prepare("SELECT value FROM meta WHERE key = 'bnb_live_failed'").get() as { value: string } | undefined)?.value ? Number((this.d.db.prepare("SELECT value FROM meta WHERE key = 'bnb_live_failed'").get() as { value: string }).value) : 0; }
  private setFailed(n: number) { this.d.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('bnb_live_failed', ?)").run(String(n)); }
  resetFailed() { this.setFailed(0); }
  private todayPnl(): number { return (this.d.db.prepare("SELECT COALESCE(SUM(net_usd),0) s FROM bnb_live_positions WHERE closed_at IS NOT NULL AND date(closed_at/1000,'unixepoch') = ?").get(todayUtc()) as { s: number }).s; }

  /** Miért nem léphetünk be most (null = léphetünk). A dry_run külön ág: ott csak jelzés. */
  private block(liq: number, balBnb: number | null): string | null {
    if (stopFileExists()) return "stop_file";
    if (this.failed() >= this.L.max_consecutive_failed) return "max_consecutive_failed";
    if (this.open.size >= this.L.max_open) return "max_open";
    if (this.todayPnl() <= -this.L.daily_loss_limit_usd) return "daily_loss_limit";
    if (liq < this.L.min_liq_bnb) return "sekély_pár";
    const usd = this.d.bnbUsd(); if (!usd) return "nincs_bnb_usd";
    if (balBnb !== null && balBnb < this.L.position_usd / usd + this.L.gas_reserve_bnb) return "kevés_bnb";
    return null;
  }

  /** Az árnyékkar jelzése (az eladhatósági próba után). */
  async onSignal(pair: string, token: string, arm: string, price: number, liq: number, signalAt: number): Promise<void> {
    const { cfg, db } = this.d;
    if (!this.L.enabled || arm !== this.L.arm) return;
    this.stats.signals++;
    if (cfg.mode === "dry_run") { await this.d.notify(`🧪 dry_run: a BNB élő kar (${arm}) BELÉPNE ${token} ${this.L.position_usd.toFixed(2)} USD-vel (likviditás ${liq.toFixed(1)} BNB)`); return; }
    if ([...this.open.values()].some((p) => p.pair === pair)) return;
    const bal = await this.c.getBalance({ address: this.address }).then((b) => Number(formatEther(b))).catch(() => null);
    const why = this.block(liq, bal);
    if (why) { this.stats.blocked++; log.info("BNB élő belépés blokkolva", { token, why }); return; }
    const usd = this.d.bnbUsd()!; const amountIn = BigInt(Math.floor(this.L.position_usd / usd * 1e18));
    const tokenA = getAddress(token), path = [BNB.wbnb, tokenA] as const;
    const t0 = this.now();
    let quoted: bigint;
    try { quoted = (await this.c.readContract({ address: BNB.pancakeV2Router, abi: ROUTER_ABI, functionName: "getAmountsOut", args: [amountIn, [...path]] }))[1]!; }
    catch (e) { this.fail("buy_quote", null, (e as Error).message); return; }
    const minOut = quoted * BigInt(Math.round((100 - this.L.buy_slippage_pct) * 100)) / 10000n;
    const deadline = BigInt(Math.floor(this.now() / 1000) + cfg.execution.deadline_sec);
    const before = await this.c.readContract({ address: tokenA, abi: ERC20, functionName: "balanceOf", args: [this.address] }).catch(() => 0n);
    const r = await this.send({ to: BNB.pancakeV2Router, value: amountIn, abi: ROUTER_ABI, fn: "swapExactETHForTokensSupportingFeeOnTransferTokens", args: [minOut, [...path], this.address, deadline] }, "buy");
    if (!r.ok) { this.fail("buy", null, r.error ?? "?", r); return; }
    const after = await this.balanceAfter(tokenA, before);
    const got = after - before;
    if (got <= 0n) { this.fail("buy_no_tokens", null, "a vétel után nem nőtt a token-egyenleg", r); return; }
    let decimals = 18; try { decimals = Number(await this.c.readContract({ address: tokenA, abi: ERC20, functionName: "decimals" })); } catch { /* 18 */ }
    const entry = Number(formatEther(amountIn)) / (Number(got) / 10 ** decimals); // BNB / token (a felvevő ára: WBNB-tartalék / token-tartalék nyers – a szorzó számít)
    const ins = db.prepare(`INSERT INTO bnb_live_positions(pair, token, arm, signal_at, opened_at, spent_bnb, spent_usd, tokens, tokens_left, entry_price, quoted_price, liq_at_entry, gas_bnb, peak_price, last_price)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(pair, tokenA, arm, signalAt, this.now(), Number(formatEther(amountIn)), this.L.position_usd, Number(got), Number(got), price, Number(formatEther(amountIn)) / (Number(quoted) / 10 ** decimals), liq, r.gasBnb, price, price);
    const id = Number(ins.lastInsertRowid);
    const pos: Pos = { id, pair, token: tokenA, arm, openedAt: this.now(), spentBnb: Number(formatEther(amountIn)), spentUsd: this.L.position_usd, tokens: got, entry: price, peak: price, phase: "open", approved: false, sellAttempts: 0, decimals };
    this.open.set(id, pos); this.stats.buys++; this.setFailed(0);
    this.fill(id, "buy", r, Number(formatEther(amountIn)), Number(got) / 10 ** decimals, entry);
    await this.d.notify(`🟢 BNB ÉLŐ VÉTEL ${tokenA.slice(0, 8)}… ${this.L.position_usd.toFixed(2)} USD · ${(Number(got) / 10 ** decimals).toLocaleString("hu-HU", { maximumFractionDigits: 0 })} token · jegyzett→kapott ${(Number(got) / Number(quoted) * 100).toFixed(1)}% · ${this.now() - t0} ms · ${r.hash}`);
    void this.approve(pos).catch(() => undefined);
  }

  private async approve(p: Pos) {
    const allowance = await this.c.readContract({ address: p.token, abi: ERC20, functionName: "allowance", args: [this.address, BNB.pancakeV2Router] }).catch(() => 0n);
    if (allowance >= p.tokens) { p.approved = true; this.d.db.prepare("UPDATE bnb_live_positions SET approved = 1 WHERE id = ?").run(p.id); return; }
    const r = await this.send({ to: p.token, value: 0n, abi: ERC20, fn: "approve", args: [BNB.pancakeV2Router, MAX_UINT] }, "approve");
    this.fill(p.id, "approve", r, 0, 0, null);
    if (r.ok) { p.approved = true; this.d.db.prepare("UPDATE bnb_live_positions SET approved = 1, gas_bnb = gas_bnb + ? WHERE id = ?").run(r.gasBnb, p.id); }
  }

  /** A felvevő körének végén: a kar állapotával (ár, kör alatti csúcs/mélypont, likviditás) kiszállási döntés. */
  async step(state: (pair: string) => { price: number; liq: number; hi: number; lo: number } | undefined): Promise<void> {
    const now = this.now();
    for (const p of [...this.open.values()]) {
      if (this.busy.has(p.id) || p.openedAt >= now) continue;
      const s = state(p.pair); if (!s || !(s.price > 0)) continue;
      p.peak = Math.max(p.peak, s.hi);
      const x = (v: number) => v / p.entry;
      let reason: string | null = null;
      if (s.liq < RUG_LIQ) reason = "drained";
      else if (x(s.hi) >= 2) reason = "tp_2x";
      else if (x(s.lo) <= 0.6) reason = "sl_40%";
      else if (now - p.openedAt >= HORIZON_MS) reason = "time_6h";
      this.d.db.prepare("UPDATE bnb_live_positions SET peak_price = ?, last_price = ? WHERE id = ?").run(p.peak, s.price, p.id);
      if (reason) await this.exit(p, reason, reason === "drained" ? null : this.L.sell_slippage_pct);
    }
  }

  /** Eladás a teljes egyenlegre; revert → pánik-csúszással újra; utána unsellable. Kiürült pár: nincs eladás, érték 0. */
  async exit(p: Pos, reason: string, slippagePct: number | null): Promise<void> {
    this.busy.add(p.id);
    try {
      const usd = this.d.bnbUsd() ?? 0;
      if (slippagePct === null) { this.close(p, reason, 0, usd); await this.d.notify(`🔴 BNB ÉLŐ: ${p.token.slice(0, 8)}… kiürült – a pozíció nullát ér (−${p.spentUsd.toFixed(2)} USD)`); return; }
      if (!p.approved) await this.approve(p);
      const bal = await this.c.readContract({ address: p.token, abi: ERC20, functionName: "balanceOf", args: [this.address] }).catch(() => p.tokens);
      if (bal <= 0n) { this.close(p, `${reason}_no_balance`, 0, usd); return; }
      const path = [p.token, BNB.wbnb] as const;
      let quotedOut = 0n; try { quotedOut = (await this.c.readContract({ address: BNB.pancakeV2Router, abi: ROUTER_ABI, functionName: "getAmountsOut", args: [bal, [...path]] }))[1]!; } catch { /* nincs jegyzés */ }
      const attempt = async (slip: number) => {
        const minOut = quotedOut * BigInt(Math.round((100 - slip) * 100)) / 10000n;
        const deadline = BigInt(Math.floor(this.now() / 1000) + this.d.cfg.execution.deadline_sec);
        const before = await this.c.getBalance({ address: this.address });
        const r = await this.send({ to: BNB.pancakeV2Router, value: 0n, abi: ROUTER_ABI, fn: "swapExactTokensForETHSupportingFeeOnTransferTokens", args: [bal, minOut, [...path], this.address, deadline] }, "sell");
        const after = r.ok ? await this.c.getBalance({ address: this.address }) : before;
        const received = r.ok ? Number(formatEther(after - before)) + r.gasBnb : 0;
        return { r, received };
      };
      let { r, received } = await attempt(slippagePct); p.sellAttempts++;
      if (!r.ok) { ({ r, received } = await attempt(this.L.panic_slippage_pct)); p.sellAttempts++; }
      this.fill(p.id, "sell", r, received, Number(bal) / 10 ** p.decimals, received > 0 ? received / (Number(bal) / 10 ** p.decimals) : null);
      if (!r.ok) {
        this.fail("sell", p.id, r.error ?? "?", r);
        this.d.db.prepare("UPDATE bnb_live_positions SET phase = 'unsellable', sell_attempts = ?, close_reason = ? WHERE id = ?").run(p.sellAttempts, `unsellable:${reason}`, p.id);
        if (p.sellAttempts >= 4) { this.close(p, `unsellable:${reason}`, 0, usd); await this.d.notify(`⛔ BNB ÉLŐ: ${p.token.slice(0, 8)}… ELADHATATLAN (honeypot?) – ${reason}, 4 kísérlet; −${p.spentUsd.toFixed(2)} USD`); }
        return;
      }
      this.close(p, reason, received, usd, r.gasBnb);
      this.stats.sells++;
      const net = (received - p.spentBnb) * usd;
      await this.d.notify(`${net >= 0 ? "🟢" : "🔴"} BNB ÉLŐ ELADÁS ${p.token.slice(0, 8)}… ${reason} · kapott ${received.toFixed(5)} BNB · nettó ${net >= 0 ? "+" : ""}${net.toFixed(2)} USD · ${r.hash}`);
    } finally { this.busy.delete(p.id); }
  }

  /** /panic: minden nyitott élő BNB-pozíció eladása pánik-csúszással. */
  async panic(): Promise<string> {
    const list = [...this.open.values()]; let n = 0;
    for (const p of list) { await this.exit(p, "panic", this.L.panic_slippage_pct).catch(() => undefined); if (!this.open.has(p.id)) n++; }
    return `BNB: ${n}/${list.length} pozíció eladva`;
  }

  private close(p: Pos, reason: string, receivedBnb: number, usd: number, extraGas = 0) {
    const gas = (this.d.db.prepare("SELECT gas_bnb g FROM bnb_live_positions WHERE id = ?").get(p.id) as { g: number }).g + extraGas;
    const net = (receivedBnb - p.spentBnb - gas) * usd;
    this.d.db.prepare("UPDATE bnb_live_positions SET tokens_left = 0, received_bnb = ?, gas_bnb = ?, phase = 'closed', closed_at = ?, close_reason = ?, net_usd = ?, sell_attempts = ? WHERE id = ?").run(receivedBnb, gas, this.now(), reason, net, p.sellAttempts, p.id);
    this.open.delete(p.id);
    logEvent(this.d.db, "bnb_live_close", `${reason} ${net.toFixed(3)} USD`);
  }

  private fail(kind: string, posId: number | null, error: string, r?: Sent) {
    this.stats.failed++; const n = this.failed() + 1; this.setFailed(n);
    if (posId !== null && r) this.fill(posId, kind, r, 0, 0, null);
    log.warn(`BNB élő ${kind} HIBA`, { error: error.slice(0, 160), egymás_után: n });
    if (n >= this.L.max_consecutive_failed) { logEvent(this.d.db, "pause", "bnb_live max_consecutive_failed"); void this.d.notify(`⛔ BNB élő: ${n} egymást követő hiba – nincs új BNB-vétel, amíg /resume`); }
  }
  private fill(posId: number, kind: string, r: Sent, bnb: number, tokens: number, price: number | null) {
    this.d.db.prepare("INSERT INTO bnb_live_fills(position_id, kind, at, tx_hash, status, gas_bnb, bnb, tokens, price, latency_ms, error) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(posId, kind, this.now(), r.hash, r.ok ? "success" : "failed", r.gasBnb, bnb, tokens, price, r.latencyMs, r.error);
  }

  private async balanceAfter(token: Address, before: bigint): Promise<bigint> {
    let b = before;
    for (let i = 0; i < 8; i++) { b = await this.c.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [this.address] }).catch(() => before); if (b !== before) return b; await new Promise((r) => setTimeout(r, 500)); }
    return b;
  }

  /** Egy tranzakció: becslés → gázplafon → küldés (legacy gasPrice) → nyugta. A kulcsot csak a viem account használja. */
  private async send(tx: { to: Address; value: bigint; abi: readonly unknown[]; fn: string; args: readonly unknown[] }, label: string): Promise<Sent> {
    const t0 = this.now();
    if (this.d.cfg.mode === "dry_run") return { ok: false, hash: null, gasBnb: 0, error: "dry_run", latencyMs: 0 };
    const data = encodeFunctionData({ abi: tx.abi, functionName: tx.fn, args: tx.args } as never);
    let gas: bigint;
    try { gas = await this.c.estimateGas({ account: this.account, to: tx.to, data, value: tx.value }); }
    catch (e) { return { ok: false, hash: null, gasBnb: 0, error: "szimuláció revert: " + (e as Error).message.split("\n")[0]!.slice(0, 160), latencyMs: this.now() - t0 }; }
    const chainGas = await this.c.getGasPrice().catch(() => 0n);
    const gasPrice = chainGas > BigInt(Math.round(this.L.gas_gwei * 1e9)) ? chainGas : BigInt(Math.round(this.L.gas_gwei * 1e9));
    const usd = this.d.bnbUsd() ?? 0, estUsd = Number(formatEther(gas * gasPrice)) * usd;
    if (estUsd > this.L.max_gas_usd_per_tx) return { ok: false, hash: null, gasBnb: 0, error: `gáz ${estUsd.toFixed(3)} USD > plafon ${this.L.max_gas_usd_per_tx}`, latencyMs: this.now() - t0 };
    let hash: Hex | null = null;
    try {
      hash = await this.w.sendTransaction({ account: this.account, chain: bsc, to: tx.to, data, value: tx.value, gas: (gas * 13n) / 10n, gasPrice });
      const rcpt = await this.rc.waitForTransactionReceipt({ hash, timeout: 60_000 }).catch(() => this.c.waitForTransactionReceipt({ hash: hash!, timeout: 60_000 }));
      const gasBnb = Number(formatEther(rcpt.gasUsed * (rcpt.effectiveGasPrice ?? gasPrice)));
      if (rcpt.status !== "success") return { ok: false, hash, gasBnb, error: "reverted", latencyMs: this.now() - t0 };
      log.info(`BNB élő tx ${label} ok`, { hash, gasBnb, ms: this.now() - t0 });
      return { ok: true, hash, gasBnb, error: null, latencyMs: this.now() - t0 };
    } catch (e) { return { ok: false, hash, gasBnb: 0, error: (e as Error).message.split("\n")[0]!.slice(0, 160), latencyMs: this.now() - t0 }; }
  }
}
interface Sent { ok: boolean; hash: Hex | null; gasBnb: number; error: string | null; latencyMs: number }
