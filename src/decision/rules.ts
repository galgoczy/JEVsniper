import type { Config } from "../config.js";
import type { ParamSnapshot } from "../collector/types.js";
import type { entryQuestions } from "../jev/questions.js";
import type { SystemOneResult } from "@typesafe-ai/sdk";
import { scoreTo100 } from "../jev/questions.js";
import { keccak256, stringToHex } from "viem";

export type EntryAnswers = SystemOneResult<typeof entryQuestions>["answers"];
export type Regime = "hot" | "normal" | "cold" | "risk_off";

export interface Labels {
  contract_risk: string; p_clean: number; creator_profile: string; wallet_pattern: string; p_bad_wallet: number;
  buyer_quality: number; crowd_type: string; p_bad_crowd: number; dev_behavior: string; trade_pattern: string;
  narrative_fit: number; copycat: string; social_quality: number; entry_timing: string; p_tp1: number; p_stop: number; p_neither: number;
}

/** A Jev-válaszok tömör címkékké (a DB-be a teljes válasz megy, ez a döntéshez kell). */
export function labelsFrom(a: EntryAnswers): Labels {
  const wp = a.wallet_pattern.probabilities, ct = a.crowd_type.probabilities;
  return {
    contract_risk: a.contract_risk.choice, p_clean: a.contract_risk.probabilities.clean,
    creator_profile: a.creator_profile.choice,
    wallet_pattern: a.wallet_pattern.choice, p_bad_wallet: wp.bot_farm + wp.bundled + wp.airdrop_farm,
    buyer_quality: scoreTo100(a.buyer_quality.score),
    crowd_type: a.crowd_type.choice, p_bad_crowd: ct.bots + ct.insiders,
    dev_behavior: a.dev_behavior.choice, trade_pattern: a.trade_pattern.choice,
    narrative_fit: scoreTo100(a.narrative_fit.score), copycat: a.copycat.choice, social_quality: scoreTo100(a.social_quality.score),
    entry_timing: a.entry_timing.choice,
    p_tp1: a.outcome.probabilities.tp1_first, p_stop: a.outcome.probabilities.stop_first, p_neither: a.outcome.probabilities.neither_24h,
  };
}

export interface RuleResult { enter: boolean; reasons: string[]; sizeMultiplier: number }

/** 6.5 Élő belépési szabály: minden feltétel teljesüljön. A visszaadott okok a naplóba mennek. */
export function liveEntryRule(l: Labels, snap: ParamSnapshot, regime: Regime, cfg: Config["entry"]): RuleResult {
  const reasons: string[] = [];
  if (!(l.contract_risk === "clean" && l.p_clean > cfg.contract_risk_clean_min_p)) reasons.push(`contract_risk=${l.contract_risk}(${l.p_clean.toFixed(2)})`);
  if (l.creator_profile === "serial_rugger") reasons.push("creator=serial_rugger");
  if (["bot_farm", "bundled", "airdrop_farm"].includes(l.wallet_pattern) && l.p_bad_wallet > cfg.bad_wallet_pattern_max_p) reasons.push(`wallet_pattern=${l.wallet_pattern}`);
  if (["bots", "insiders"].includes(l.crowd_type) && l.p_bad_crowd > cfg.bad_crowd_type_max_p) reasons.push(`crowd=${l.crowd_type}`);
  if (l.dev_behavior === "distributing") reasons.push("dev=distributing");
  if (!["organic_accumulation", "coordinated_pump"].includes(l.trade_pattern)) reasons.push(`trade_pattern=${l.trade_pattern}`);
  if (!["early", "good"].includes(l.entry_timing)) reasons.push(`timing=${l.entry_timing}`);
  if (l.buyer_quality < cfg.buyer_quality_min) reasons.push(`buyer_quality=${l.buyer_quality}`);
  const thr = regime === "hot" ? cfg.tp1_first_min_p.hot : regime === "cold" ? cfg.tp1_first_min_p.cold : cfg.tp1_first_min_p.normal;
  if (regime === "risk_off") reasons.push("regime=risk_off");
  else if (!(l.p_tp1 > thr)) reasons.push(`p_tp1=${l.p_tp1.toFixed(2)}<=${thr}`);
  const sm = snap.buyers.smart_money_count;
  const boost = l.buyer_quality >= cfg.size_boost.buyer_quality_min && sm >= cfg.size_boost.smart_money_min && l.p_tp1 > cfg.size_boost.tp1_first_min_p;
  return { enter: reasons.length === 0, reasons, sizeMultiplier: boost ? cfg.size_boost.multiplier : 1 };
}

/** Árnyékkar: csak a Jev közvetlen jóslása, adott küszöbbel. */
export const jevDirectArm = (l: Labels, threshold: number): RuleResult => ({ enter: l.p_tp1 > threshold, reasons: l.p_tp1 > threshold ? [] : [`p_tp1=${l.p_tp1.toFixed(2)}`], sizeMultiplier: 1 });

/** Árnyékkar: egyszerű, Jev nélküli pontszám a paraméterekből (0–100), 60 felett belép. */
export function ruleScore(s: ParamSnapshot): number {
  const n = (v: unknown, d = 0) => (typeof v === "number" ? v : d);
  let sc = 50;
  sc += Math.min(15, n(s.holders.count) / 5);                              // holderek
  sc += Math.min(10, n(s.dynamics.unique_buyers_per_min) * 2);             // egyedi vevők/perc
  sc += n(s.dynamics.buyer_acceleration, 1) > 1.2 ? 8 : n(s.dynamics.buyer_acceleration, 1) < 0.8 ? -8 : 0;
  sc += n(s.dynamics.buy_sell_ratio, 1) >= 3 ? 6 : n(s.dynamics.buy_sell_ratio, 1) < 1 ? -10 : 0;
  sc -= Math.max(0, n(s.holders.top10_pct_ex_creator) - 40) / 2;           // koncentráció
  sc -= n(s.holders.fresh_wallet_ratio_top20) > 0.7 ? 10 : 0;
  sc -= n(s.buyers.bot_ratio) > 0.5 ? 10 : 0;
  sc -= n(s.creator.token_share_pct) > 10 ? 8 : 0;
  sc -= s.creator.sold_any === true ? 15 : 0;
  sc += s.buyers.smart_money_count * 5;
  sc -= s.buyers.known_scammer_count * 10;
  sc -= n(s.meta.copycats_24h) > 3 ? 5 : 0;
  sc += n(s.creator.prior_graduated) > 0 ? 5 : 0;
  return Math.max(0, Math.min(100, Math.round(sc)));
}
export const ruleScoreArm = (s: ParamSnapshot, min = 60): RuleResult => { const v = ruleScore(s); return { enter: v >= min, reasons: [`rule_score=${v}`], sizeMultiplier: 1 }; };

/** Véletlen kontroll: a szűrőn átmentek adott hányada (determinisztikus a token címéből, hogy ne függjön az ablaktól). */
export function randomControlArm(tokenAddress: string, share: number): RuleResult {
  const h = keccak256(stringToHex(tokenAddress.toLowerCase()));
  const u = Number(BigInt(h.slice(0, 10)) % 10000n) / 10000; // első 4 bájt → egyenletes [0,1)
  return { enter: u < share, reasons: [`u=${u.toFixed(3)}`], sizeMultiplier: 1 };
}

/**
 * rule_v2 – adatvezérelt jelölt szabály (2026-09-23 paraméter-informativitás alapján, 60 mp pillanatkép):
 * holderek ≥10, bot-arány <0,1, vevő-gyorsulás ≥1,2, ár a launch fölött, csúcstól <25%, creator: nincs korábbi
 * tokenje és nem adott el; Jev: nem bot_farm, nem bots. "strict": +gyorsulás ≥2 vagy curve-haladás ≥60%.
 */
export function ruleV2(s: ParamSnapshot, l: Labels | null, variant: "loose" | "strict" = "loose"): RuleResult {
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const r: string[] = [];
  const holders = n(s.holders.count) ?? 0;
  if (holders < 10) r.push(`holders=${holders}`);
  const bot = n(s.buyers.bot_ratio); if (bot !== null && bot >= 0.1) r.push(`bot_ratio=${bot.toFixed(2)}`);
  const acc = n(s.dynamics.buyer_acceleration) ?? 1; if (acc < 1.2) r.push(`accel=${acc.toFixed(2)}`);
  const chg = n(s.dynamics.price_change_pct_since_launch); if (chg !== null && chg <= 0) r.push(`price_chg=${chg.toFixed(0)}`);
  const dd = n(s.dynamics.peak_drawdown_pct); if (dd !== null && dd >= 25) r.push(`drawdown=${dd.toFixed(0)}`);
  const prior = n(s.creator.prior_tokens) ?? 0; if (prior >= 1) r.push(`creator_prior=${prior}`);
  if (s.creator.sold_any === true) r.push("creator_sold");
  if (l && ["bot_farm", "airdrop_farm"].includes(l.wallet_pattern)) r.push(`wallet=${l.wallet_pattern}`);
  if (l && l.crowd_type === "bots") r.push("crowd=bots");
  if (l && ["dead", "stalling"].includes(l.trade_pattern)) r.push(`trade=${l.trade_pattern}`);
  if (variant === "strict") {
    const prog = n(s.contract.bonding_curve_progress_pct);
    if (!(acc >= 2 || (prog !== null && prog >= 60))) r.push("strict:accel<2&curve<60");
  }
  return { enter: r.length === 0, reasons: r, sizeMultiplier: 1 };
}
