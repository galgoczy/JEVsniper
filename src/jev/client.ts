import { TypeSafeClient, APIError, RateLimitError, type Questions, type SystemOneResult } from "@typesafe-ai/sdk";
import type { Config } from "../config.js";
import type { DB } from "../db/index.js";
import { nowMs, todayUtc } from "../db/index.js";
import { log } from "../logger.js";

export interface JevCallMeta {
  purpose: "entry" | "hold" | "regime" | "verify";
  tokenId?: number;
  windowSec?: number;
  blockNumber?: number;
  priceNative?: number;
  reserveNative?: number;
  reserveToken?: number;
}

export interface JevCallResult<Q extends Questions> {
  callId: number;
  answers: SystemOneResult<Q>["answers"];
  costUsd: number;
  inputTokens: number;
  latencyMs: number;
}

/**
 * Jev-kliens: egy hívásban az összes kérdés (kötegelés), minden válasz DB-be mentve
 * az összes valószínűséggel. Hiba/rate limit/időtúllépés → `paused` állapot; ilyenkor
 * a döntési motor nem nyit új pozíciót (a vészkilépések ettől függetlenek).
 *
 * API-tények (typesafe.ai dokumentáció, 2026-09):
 * - POST https://api.typesafe.ai/v1/systemone, egy state + N kérdés, egy válaszban minden
 * - limit: 64k token (state+minden kérdés), 32k (state+leghosszabb kérdés); ~150k karakter
 * - rate limit: 1200 kérés/perc, 250k token/mp → 429
 * - ár: 0,042 USD / 1M input token, output ingyenes
 */
export class JevClient {
  private client: TypeSafeClient;
  private consecutiveErrors = 0;
  private pausedUntil = 0;

  constructor(private db: DB, private cfg: Config, apiKey: string, fetchImpl?: typeof fetch) {
    this.client = new TypeSafeClient({
      apiKey,
      ...(fetchImpl ? { fetch: fetchImpl as never } : {}),
      defaultModel: cfg.jev.model,
      timeout: cfg.jev.timeout_ms,
      retry: { maxRetries: cfg.jev.max_retries },
      logLevel: "off", // saját logger; az SDK debug szintje kiírná a kérés törzsét
    });
  }

  get paused(): boolean { return Date.now() < this.pausedUntil; }
  get pausedUntilMs(): number { return this.pausedUntil; }

  /** Napi Jev-költség (USD) a DB-ből. */
  dailyCostUsd(day = todayUtc()): number {
    const r = this.db.prepare("SELECT COALESCE(jev_cost_usd,0) c FROM daily_state WHERE day = ?").get(day) as { c: number } | undefined;
    return r?.c ?? 0;
  }

  get overDailyBudget(): boolean {
    return this.dailyCostUsd() >= this.cfg.risk.jev_daily_budget_usd;
  }

  async ask<const Q extends Questions>(state: Record<string, unknown> | string, questions: Q, meta: JevCallMeta): Promise<JevCallResult<Q>> {
    if (this.paused) throw new JevPausedError(this.pausedUntil);
    const started = nowMs();
    const insert = this.db.prepare(`INSERT INTO jev_calls(purpose, token_id, window_sec, called_at, block_number,
      price_native, reserve_native, reserve_token, model, input_tokens, output_tokens, cost_usd, latency_ms, ok, error, answers_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    try {
      const res = await this.client.systemOne({ state: state as never, questions });
      const latency = nowMs() - started;
      const cost = (res.usage.input_tokens / 1_000_000) * this.cfg.jev.usd_per_million_input_tokens;
      const info = insert.run(meta.purpose, meta.tokenId ?? null, meta.windowSec ?? null, started, meta.blockNumber ?? null,
        meta.priceNative ?? null, meta.reserveNative ?? null, meta.reserveToken ?? null, res.model,
        res.usage.input_tokens, res.usage.output_tokens, cost, latency, 1, null, JSON.stringify(res.answers));
      this.db.prepare("INSERT INTO daily_state(day, jev_cost_usd) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET jev_cost_usd = jev_cost_usd + excluded.jev_cost_usd")
        .run(todayUtc(), cost);
      this.consecutiveErrors = 0;
      return { callId: Number(info.lastInsertRowid), answers: res.answers, costUsd: cost, inputTokens: res.usage.input_tokens, latencyMs: latency };
    } catch (err) {
      const latency = nowMs() - started;
      const msg = describeError(err);
      insert.run(meta.purpose, meta.tokenId ?? null, meta.windowSec ?? null, started, meta.blockNumber ?? null,
        meta.priceNative ?? null, meta.reserveNative ?? null, meta.reserveToken ?? null, this.cfg.jev.model,
        null, null, 0, latency, 0, msg, null);
      this.consecutiveErrors++;
      let pauseMs = 0;
      if (err instanceof RateLimitError) pauseMs = Math.max(err.retryAfterMs ?? 0, 10_000);
      if (this.consecutiveErrors >= this.cfg.jev.pause_after_consecutive_errors) pauseMs = Math.max(pauseMs, this.cfg.jev.pause_minutes * 60_000);
      if (pauseMs > 0) {
        this.pausedUntil = Date.now() + pauseMs;
        log.warn("Jev szünetel", { untilIso: new Date(this.pausedUntil).toISOString(), reason: msg });
      }
      throw new JevError(msg, err);
    }
  }
}

export class JevError extends Error {
  constructor(msg: string, public cause?: unknown) { super(msg); this.name = "JevError"; }
}
export class JevPausedError extends Error {
  constructor(public until: number) { super(`Jev szünetel eddig: ${new Date(until).toISOString()}`); this.name = "JevPausedError"; }
}

function describeError(err: unknown): string {
  if (err instanceof APIError) return `HTTP ${err.status}: ${err.message}`.slice(0, 300);
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 300);
  return String(err).slice(0, 300);
}
