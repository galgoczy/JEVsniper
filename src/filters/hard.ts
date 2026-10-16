import type { Config } from "../config.js";
import type { ParamSnapshot } from "../collector/types.js";

/**
 * 6.3 Kemény szűrők – kódban, azonnal, Jev nélkül. Az első találat kiejt, de az összes okot visszaadjuk
 * a naplózáshoz. "unknown" érték nem ejt ki (nincs adat ≠ rossz adat), kivéve ahol a spec kifejezetten
 * a hiányt bünteti (nem ismert sablon ÉS veszélyes jogok).
 */
export interface FilterResult { pass: boolean; reasons: string[] }

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function hardFilters(s: ParamSnapshot, cfg: Config["hard_filters"], flags: { paid_boost_only?: boolean } = {}): FilterResult {
  const reasons: string[] = [];
  const c = s.contract;

  if (c.sell_simulation === "failed") reasons.push("sell_simulation_failed");
  if (isNum(c.sell_tax_pct) && c.sell_tax_pct > cfg.max_sell_tax_pct) reasons.push(`sell_tax_${c.sell_tax_pct}pct`);

  const dangerous = Array.isArray(c.dangerous_rights) && c.dangerous_rights.length > 0;
  if (c.known_template !== true && dangerous) reasons.push(`unknown_template_with_rights:${(c.dangerous_rights as string[]).join("|")}`);

  if (c.liquidity_locked === false) reasons.push("liquidity_not_locked");
  if (isNum(c.liquidity_usd) && c.liquidity_usd < cfg.min_initial_liquidity_usd) reasons.push(`liquidity_below_min_${Math.round(c.liquidity_usd)}usd`);

  if (s.creator.status === "known_scammer") reasons.push("creator_known_scammer");
  // korábbi tokenek rug-aránya: a sorsot a 7. lépés kilépés-követése adja; addig csak a lista-státusz él

  if (isNum(s.holders.funding_clusters_top20) && s.holders.funding_clusters_top20 > cfg.funding_cluster_top20_max) reasons.push(`funding_clusters_${s.holders.funding_clusters_top20}`);
  if (isNum(s.holders.airdrop_received_ratio) && s.holders.airdrop_received_ratio > cfg.airdrop_received_ratio_max) reasons.push(`airdrop_spam_${Math.round(s.holders.airdrop_received_ratio * 100)}pct`);
  if (s.buyers.known_scammer_count > cfg.known_scammer_wallets_max) reasons.push(`scammer_wallets_${s.buyers.known_scammer_count}`);

  if (flags.paid_boost_only || (s.social.paid_boost === true && (s.buyers.unique_buyers === 0 || s.buyers.unique_buyers === "unknown"))) reasons.push("paid_boost_only");

  return { pass: reasons.length === 0, reasons };
}
