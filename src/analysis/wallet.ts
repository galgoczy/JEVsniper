import type { DB } from "../db/index.js";
import type { Config } from "../config.js";

/**
 * Tárca-igény (2026-10-03): ha a beállított élő kar (live_entry.arm, élő ablak, live_entry.exit_plan) élesben futott volna
 * a Base-en, egyszerre legfeljebb hány pozíciója lett volna nyitva, és ez az élő pozícióméretnél (2 USD) mennyi pénzt köt le.
 * Az árnyékpozíciókból számol (1 USD-s mérés, az időzítés ugyanaz). A tartalék a pozíciók gasára (vétel + legfeljebb 3 eladás).
 */
export interface WalletNeed { positions: number; peakOpen: number; peakAt: number | null; openNow: number; needUsd: number; liveSizeUsd: number }

export function walletNeed(db: DB, cfg: Config, sinceMs: number, liveSizeUsd: number, now = Date.now()): WalletNeed {
  const rows = db.prepare(`SELECT opened_at o, closed_at c FROM positions WHERE arm = ? AND window_sec = ? AND exit_plan = ? AND chain = 'base'
    AND opened_at > ? AND (close_reason IS NULL OR close_reason NOT LIKE 'invalid%')`)
    .all(cfg.live_entry.arm, cfg.evaluation.live_window_sec, cfg.live_entry.exit_plan, sinceMs) as Array<{ o: number; c: number | null }>;
  // eseménysöprés: nyitás +1, zárás −1 (azonos időpontban előbb a zárás)
  const ev = rows.flatMap((r) => [[r.o, 1], [r.c ?? now + 1, -1]] as Array<[number, number]>).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0, peakAt: number | null = null;
  for (const [t, d] of ev) { cur += d; if (cur > peak) { peak = cur; peakAt = t; } }
  const gasBuffer = 0.02 * 4; // Base: ~0,015–0,02 USD tranzakciónként (mért átlag ~0,015/pozíció), vétel + 3 eladás
  return { positions: rows.length, peakOpen: peak, peakAt, openNow: rows.filter((r) => r.c === null).length, needUsd: peak * (liveSizeUsd + gasBuffer), liveSizeUsd };
}

/** A futó bot által mentett Base-tárcaegyenleg (meta: wallet_base_eth, wallet_eth_usd, wallet_at), ha van. */
export function savedWalletBalance(db: DB): { usd: number; at: number } | null {
  const get = (k: string) => (db.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined)?.value;
  const eth = Number(get("wallet_base_eth")), px = Number(get("wallet_eth_usd")), at = Number(get("wallet_at"));
  return Number.isFinite(eth) && px > 0 && at > 0 ? { usd: eth * px, at } : null;
}

export function walletLine(db: DB, cfg: Config, sinceMs: number, liveSizeUsd: number, now = Date.now()): string {
  const w = walletNeed(db, cfg, sinceMs, liveSizeUsd, now);
  const bal = savedWalletBalance(db);
  const when = w.peakAt ? ` (${new Date(w.peakAt).toISOString().slice(5, 16).replace("T", " ")} UTC)` : "";
  const balTxt = bal ? `; Base-tárca most ~${bal.usd.toFixed(2)} USD → ${bal.usd >= w.needUsd ? "✅ elég" : "⚠️ KEVÉS"}` : "; Base-tárca egyenlege: még nincs mérve";
  return `💰 Tárca-igény (${cfg.live_entry.arm}, ${liveSizeUsd.toFixed(2)} USD/pozíció, ${w.positions} jelzés): egyszerre legfeljebb ${w.peakOpen} nyitott${when} → ~${w.needUsd.toFixed(2)} USD (gasszal); most nyitott ${w.openNow}${balTxt}`;
}
