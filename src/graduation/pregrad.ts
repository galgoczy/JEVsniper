import type { ChainKey } from "../chains/index.js";

/**
 * RH saját stratégia (2026-10-03): „graduáció előtti” belépés a PONS bonding curve-ön.
 * Adat (10-02 óta): a Robinhood/PONS 5x+ tokenjei mind graduáltak, az első percben viszont jellemzően semmi nem látszott
 * rajtuk; a tokenek ~99%-a soha nem mozdul. Ötlet: nem induláskor, hanem a görbe haladásának egy küszöbén lépünk be
 * (haladás = a felgyűlt quote / graduációs küszöb), hogy a soha nem mozduló tokeneket kihagyjuk, a graduációs ugrást elkapjuk.
 * Sávok: pons_pregrad_50 → 50–80% között, pons_pregrad_80 → 80–100% között az első olyan megfigyelésnél, amely a sávba esik.
 * Ha a token a sávot két ellenőrzés között átugorja (gyors, egyben felvásárolt graduáció), az adott karral nem lép be.
 * Csak natív (ETH) quote-ú görbék; az árfigyelő 15 mp-enként frissíti a görbe tartalékait.
 */
export const PREGRAD_BANDS: Array<{ arm: string; from: number; to: number }> = [
  { arm: "pons_pregrad_50", from: 50, to: 80 },
  { arm: "pons_pregrad_80", from: 80, to: 100 },
];

export interface CurveObs { chain: ChainKey; tokenId: number; progressPct: number; price: number; liquidityNative: number | null; nativeQuote: boolean }

export class PreGradArms {
  private done = new Set<string>(); // token|kar: már belépett vagy a sávot átugrotta
  constructor(private open: (tokenId: number, arm: string, price: number, liquidityNative: number | null) => Promise<number>) {}

  /** Egy görbe-megfigyelés: legfeljebb sávonként egyszer nyit árnyékpozíciót. Visszaadja a nyitott karokat. */
  async observe(o: CurveObs): Promise<string[]> {
    const opened: string[] = [];
    if (!o.nativeQuote || !(o.price > 0) || !Number.isFinite(o.progressPct)) return opened;
    for (const b of PREGRAD_BANDS) {
      const key = `${o.tokenId}|${b.arm}`;
      if (this.done.has(key) || o.progressPct < b.from) continue;
      this.done.add(key);
      if (o.progressPct >= b.to) continue; // átugrotta a sávot
      if ((await this.open(o.tokenId, b.arm, o.price, o.liquidityNative)) > 0) opened.push(b.arm);
    }
    return opened;
  }
}
