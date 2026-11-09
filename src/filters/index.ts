import type { DB } from "../db/index.js";
import { nowMs } from "../db/index.js";
import type { Config } from "../config.js";
import type { ParamSnapshot } from "../collector/types.js";
import type { TokenRow } from "../collector/index.js";
import { hardFilters, type FilterResult } from "./hard.js";
import { log } from "../logger.js";

/** Szűrő futtatása egy pillanatképre, eredmény naplózása (filter_log + tokens.status). */
export function applyHardFilters(db: DB, cfg: Config, t: TokenRow, snap: ParamSnapshot): FilterResult {
  const r = hardFilters(snap, cfg.hard_filters);
  if (!r.pass) {
    const ins = db.prepare("INSERT INTO filter_log(token_id, at, reason, detail) VALUES (?,?,?,?)");
    for (const reason of r.reasons) ins.run(t.id, nowMs(), reason.split(":")[0]!.replace(/_[\d.]+(pct|usd)$/, ""), reason);
    db.prepare("UPDATE tokens SET status = 'filtered', filter_reason = ? WHERE id = ? AND status IN ('new','evaluated')").run(r.reasons.join(","), t.id);
    log.info(`Kiesett a kemény szűrőn (${t.chain}/${t.launchpad} ${t.symbol ?? "?"})`, { reasons: r.reasons, window: snap.meta_snapshot.window_sec });
  }
  return r;
}
