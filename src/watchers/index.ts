import type { PublicClient, Address } from "viem";
import type { DB } from "../db/index.js";
import { nowMs } from "../db/index.js";
import type { ChainKey } from "../chains/index.js";
import { erc20Abi } from "../abis/uniswap.js";
import { sourcesFor, type LogSource, type NewToken } from "./sources.js";
import { log } from "../logger.js";

export interface WatcherOptions {
  pollIntervalMs: number;
  maxBlockRange: number;        // egy getLogs hívás max blokktartománya
  confirmations: number;        // hány blokkot várunk (reorg ellen)
  enabledSources: Record<string, boolean>;
  onToken?: (t: NewToken, tokenId: number) => void | Promise<void>;
}

/**
 * Láncfigyelő: blokkonként lekéri a források eseményeit (eth_getLogs, egy hívás forrásonként),
 * dekódolja, és az új tokeneket a `tokens` táblába írja. Az utolsó feldolgozott blokk a `meta`
 * táblában van, így újraindítás után onnan folytatja (max. `maxBlockRange` visszamenőleg).
 * Egyszerű polling; websocket nincs, mert a publikus RPC-k többsége nem adja.
 */
export class ChainWatcher {
  private sources: LogSource[];
  private stopped = false;
  private metaKey: string;
  public stats = { polls: 0, logs: 0, tokens: 0, errors: 0, lastBlock: 0n };

  constructor(private chain: ChainKey, private client: PublicClient, private db: DB, private opts: WatcherOptions) {
    this.sources = sourcesFor(chain, opts.enabledSources);
    this.metaKey = `watcher_last_block_${chain}`;
  }

  get sourceKeys() { return this.sources.map((s) => s.key); }

  private loadLastBlock(): bigint | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(this.metaKey) as { value: string } | undefined;
    return r ? BigInt(r.value) : null;
  }
  private saveLastBlock(b: bigint) {
    this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(this.metaKey, b.toString());
  }

  async start(): Promise<void> {
    this.stopped = false;
    const head = await this.client.getBlockNumber();
    const stored = this.loadLastBlock();
    let last: bigint = stored === null || head - stored > BigInt(this.opts.maxBlockRange) * 10n ? head - 1n : stored; // ne dolgozzunk fel órákat visszamenőleg
    log.info(`Watcher indul: ${this.chain}`, { from: last.toString(), sources: this.sourceKeys });
    while (!this.stopped) {
      try {
        const headNow = await this.client.getBlockNumber();
        const safeHead = headNow - BigInt(this.opts.confirmations);
        if (safeHead > last) {
          const to = safeHead - last > BigInt(this.opts.maxBlockRange) ? last + BigInt(this.opts.maxBlockRange) : safeHead;
          await this.processRange(last + 1n, to);
          last = to;
          this.saveLastBlock(last);
          this.stats.lastBlock = last;
          if (to < safeHead) continue; // felzárkózás, nem várunk
        }
      } catch (e) {
        this.stats.errors++;
        log.warn(`Watcher hiba (${this.chain})`, { error: (e as Error).message.slice(0, 200) });
      }
      await new Promise((r) => setTimeout(r, this.opts.pollIntervalMs));
    }
  }

  stop() { this.stopped = true; }

  /** Egy getLogs hívás az összes forrásra (címlista + eseménylista), utána cím szerint szétosztva. */
  private async processRange(from: bigint, to: bigint) {
    this.stats.polls++;
    const byAddr = new Map(this.sources.map((s) => [s.address.toLowerCase(), s] as const));
    const logs = await this.client.getLogs({
      address: this.sources.map((s) => s.address),
      events: this.sources.map((s) => s.event),
      fromBlock: from, toBlock: to,
    });
    this.stats.logs += logs.length;
    for (const l of logs) {
      const src = byAddr.get(l.address.toLowerCase());
      if (!src) continue;
      if (l.topics[0] !== src.topic0) continue; // más forrás eseménye ugyanazon a címen – nem fordul elő, de biztos ami biztos
      let t: NewToken | null = null;
      try { t = src.decode(l); } catch (e) { log.debug("dekódolási hiba", { src: src.key, error: (e as Error).message }); }
      if (!t) continue;
      await this.upsertToken(t);
    }
  }

  private async upsertToken(t: NewToken) {
    const existing = this.db.prepare("SELECT id, launchpad, discovered_block FROM tokens WHERE chain = ? AND lower(address) = lower(?)").get(t.chain, t.address) as { id: number; launchpad: string; discovered_block: number | null } | undefined;
    if (existing) {
      if (t.launchpad === "uniswap" && existing.launchpad !== "uniswap") {
        // Launchpad-token v4 poolja: ugyanabban a blokkban (Clanker) → nem graduáció, csak a PoolKey; későbbi blokkban (PONS) → graduáció.
        const sameBlock = existing.discovered_block !== null && BigInt(existing.discovered_block) === t.blockNumber;
        this.db.prepare("UPDATE tokens SET graduated_at = CASE WHEN ? THEN graduated_at ELSE COALESCE(graduated_at, ?) END, pool_key_json = COALESCE(pool_key_json, ?) WHERE id = ?")
          .run(sameBlock ? 1 : 0, nowMs(), t.poolKey ? JSON.stringify(t.poolKey) : null, existing.id);
      } else if (t.launchpad !== "uniswap" && existing.launchpad === "uniswap") {
        // A v4 Initialize hamarabb jött, mint a launchpad TokenCreated eseménye (ugyanaz a tx): pótoljuk a launchpad-adatokat.
        this.db.prepare("UPDATE tokens SET launchpad = ?, creator = COALESCE(?, creator), mechanics = ?, name = COALESCE(name, ?), symbol = COALESCE(symbol, ?), graduated_at = NULL, graduation_threshold = COALESCE(?, graduation_threshold) WHERE id = ?")
          .run(t.launchpad, t.creator, t.mechanics, t.name, t.symbol, t.graduationThreshold?.toString() ?? null, existing.id);
      }
      return;
    }
    if (!t.name || !t.symbol) {
      const meta = await this.readErc20(t.address);
      t.name = t.name ?? meta.name; t.symbol = t.symbol ?? meta.symbol;
    }
    const info = this.db.prepare(`INSERT OR IGNORE INTO tokens(chain, address, creator, launchpad, mechanics, pool_address, pair_token, name, symbol, discovered_at, discovered_block, status, graduation_threshold, pool_key_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'new',?,?)`).run(t.chain, t.address, t.creator, t.launchpad, t.mechanics, t.pool, t.pairToken, t.name, t.symbol, nowMs(), Number(t.blockNumber), t.graduationThreshold?.toString() ?? null, t.poolKey ? JSON.stringify(t.poolKey) : null);
    if (info.changes === 0) return;
    this.stats.tokens++;
    const id = Number(info.lastInsertRowid);
    log.info(`Új token (${t.chain}/${t.launchpad})`, { symbol: t.symbol, address: t.address, block: t.blockNumber.toString() });
    await this.opts.onToken?.(t, id);
  }

  private async readErc20(address: Address): Promise<{ name: string | null; symbol: string | null }> {
    try {
      const [name, symbol] = await Promise.all([
        this.client.readContract({ address, abi: erc20Abi, functionName: "name" }).catch(() => null),
        this.client.readContract({ address, abi: erc20Abi, functionName: "symbol" }).catch(() => null),
      ]);
      return { name: name as string | null, symbol: symbol as string | null };
    } catch { return { name: null, symbol: null }; }
  }
}
