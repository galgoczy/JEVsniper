import { getAddress, type PublicClient } from "viem";
import type { DB } from "../db/index.js";
import { ponsCurveAbi } from "../abis/pons.js";
import { log } from "../logger.js";

/**
 * RH mérőkar (2026-10-06): „95%-on be, graduáción ki” – a PONS graduációs ugrás mérése.
 * A 4,2 ETH-s görbe végára 1,05e-8, a hivatalos pool induló ára mindig 2,058e-8 (~1,96x). Kérdés: a 95%-ig jutó
 * tokenek elég nagy része graduál-e, és az ugrás eladható-e.
 * Haladás itt is a NYERS érték (quoteReserve / küszöb; a görbe 40%-on indul, nyers 95% ≈ valódi 91,7%).
 * Figyelés: a 15 mp-es árfigyelő-körből (observe) a nyers ≥ FLIP_WATCH_FROM görbék „forró” listára kerülnek, ezeket
 * FLIP_POLL_MS-enként külön multicall olvassa (quoteReserve, tokenReserve, graduated). Belépés csak ÁTLÉPÉSRE
 * (előző megfigyelés < 95 ≤ mostani < 100), tokenenként egyszer. Kilépés: a `flip` terv (src/exit/plans.ts).
 */
export const FLIP_ARM = "pons_flip95";
export const FLIP_ENTRY_PCT = 95;
export const FLIP_WATCH_FROM = 85;
export const FLIP_POLL_MS = 2_000;
const HOT_MAX_MS = 2 * 3600_000;

interface Hot { curve: `0x${string}`; thr: bigint; decimals: number; since: number }

export class FlipArm {
  private last = new Map<number, number>();
  private done = new Set<number>();
  private hot = new Map<number, Hot>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  stats = { watched: 0, entries: 0, polls: 0 };

  constructor(private d: { db: DB; client: PublicClient; open: (tokenId: number, price: number, liquidityNative: number | null) => Promise<number> }) {}

  /** Egy görbe-megfigyelés (árfigyelő-kör vagy gyors lekérdezés). Visszaadja, nyitott-e pozíciót. */
  async observe(o: { tokenId: number; progressPct: number; price: number; liquidityNative: number | null; nativeQuote: boolean }): Promise<boolean> {
    if (!o.nativeQuote || !(o.price > 0) || !Number.isFinite(o.progressPct) || this.done.has(o.tokenId)) return false;
    const prev = this.last.get(o.tokenId);
    this.last.set(o.tokenId, o.progressPct);
    if (o.progressPct >= FLIP_WATCH_FROM && o.progressPct < 100 && !this.hot.has(o.tokenId)) this.watch(o.tokenId);
    if (prev === undefined || prev >= FLIP_ENTRY_PCT || o.progressPct < FLIP_ENTRY_PCT) return false;
    this.done.add(o.tokenId); this.hot.delete(o.tokenId);
    if (o.progressPct >= 100) return false; // átugrotta (egyben graduált)
    const n = await this.d.open(o.tokenId, o.price, o.liquidityNative);
    if (n > 0) this.stats.entries++;
    return n > 0;
  }

  private watch(tokenId: number) {
    const t = this.d.db.prepare("SELECT pool_address, graduation_threshold, decimals FROM tokens WHERE id = ?").get(tokenId) as { pool_address: string | null; graduation_threshold: string | null; decimals: number | null } | undefined;
    if (!t?.pool_address || !/^0x[0-9a-fA-F]{40}$/.test(t.pool_address) || !t.graduation_threshold) return;
    this.hot.set(tokenId, { curve: getAddress(t.pool_address), thr: BigInt(t.graduation_threshold), decimals: t.decimals ?? 18, since: Date.now() });
    this.stats.watched++;
  }

  start() { this.timer = setInterval(() => { void this.poll().catch((e) => log.debug("flip gyors lekérdezés hiba", { error: (e as Error).message.slice(0, 100) })); }, FLIP_POLL_MS); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** A forró görbék gyors lekérdezése. */
  async poll(): Promise<void> {
    if (this.busy || !this.hot.size) return;
    this.busy = true;
    try {
      const now = Date.now();
      for (const [id, h] of this.hot) if (now - h.since > HOT_MAX_MS) this.hot.delete(id);
      const list = [...this.hot.entries()];
      if (!list.length) return;
      this.stats.polls++;
      const mc = await this.d.client.multicall({ allowFailure: true, contracts: list.flatMap(([, h]) => (["quoteReserve", "tokenReserve", "graduated"] as const).map((fn) => ({ address: h.curve, abi: ponsCurveAbi, functionName: fn }))) as never }) as Array<{ status: string; result?: unknown }>;
      for (let i = 0; i < list.length; i++) {
        const [id, h] = list[i]!;
        const q = mc[i * 3]?.status === "success" ? (mc[i * 3]!.result as bigint) : null;
        const tk = mc[i * 3 + 1]?.status === "success" ? (mc[i * 3 + 1]!.result as bigint) : null;
        const g = mc[i * 3 + 2]?.status === "success" ? (mc[i * 3 + 2]!.result as boolean) : false;
        if (g) { this.hot.delete(id); continue; }
        if (q === null || tk === null || tk <= 0n || h.thr <= 0n) continue;
        const pct = Math.min(100, Number((q * 10000n) / h.thr) / 100);
        if (pct < FLIP_WATCH_FROM - 5) { this.hot.delete(id); this.last.set(id, pct); continue; }
        await this.observe({ tokenId: id, progressPct: pct, price: Number(q) / Number(tk) * 10 ** (h.decimals - 18), liquidityNative: Number(q) / 1e18, nativeQuote: true });
      }
    } finally { this.busy = false; }
  }
}
