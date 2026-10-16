import type { DB } from "../db/index.js";

/**
 * Gyűrű-szűrő (2026-10-08): egy tárcacsoport tokenről tokenre „organikus” forgalmat színlel (vesz, routeren át elad), majd a
 * kívülálló vevőt utólag (külön tx-ben) letiltja – a vétel előtti honeypot-teszt ezt nem láthatja (AC, CSOPSKHYNIX2L: ugyanaz a 14 tárca).
 * Gyűrű-tag: legalább RING_MIN_PAIRS különböző „rossz” párban (élő pozíciónk eladhatatlan lett) vett. Egy pár gyűrűs, ha a jelzés
 * ELŐTT legalább RING_MIN_BUYERS (1) gyűrű-tag vett benne.
 */
// RING_MIN_BUYERS = 1 (2026-10-08): a +60 mp-es belépéskor a gyűrű még csak érkezik (CSOPSKHYNIX2L: 1 tag a vételünkkor, AC: 6);
// a lista szigorú (csak ≥ 2 rossz párban vásárló tárcák), így 1 tag is elég jel.
export const RING_MIN_PAIRS = 2, RING_MIN_BUYERS = 1;
const IGNORE = ["0x10ed43c718714eb63d5aa57b78b54704e256024e", "0x0000000000000000000000000000000000000000"]; // router, nulla cím

/** Egy „rossz” pár (eladhatatlan élő pozíció) vevőinek felvétele jelöltként (a saját címünk és a router nélkül). */
export function learnRingFromPair(db: DB, pair: string, ownAddress: string, now = Date.now()): number {
  const rows = db.prepare("SELECT DISTINCT lower(to_addr) a FROM bnb_pair_trades WHERE pair = ? AND side = 'buy' AND to_addr IS NOT NULL").all(pair.toLowerCase()) as Array<{ a: string }>;
  const ins = db.prepare("INSERT OR IGNORE INTO bnb_ring_candidates(addr, pair, added_at) VALUES (?,?,?)");
  let n = 0;
  for (const r of rows) if (r.a !== ownAddress.toLowerCase() && !IGNORE.includes(r.a) && r.a !== pair.toLowerCase()) n += ins.run(r.a, pair.toLowerCase(), now).changes;
  return n;
}

/** Hány gyűrű-tag vett a párban `beforeAt` előtt. */
export function ringBuyers(db: DB, pair: string, beforeAt: number): number {
  return (db.prepare(`SELECT COUNT(DISTINCT lower(t.to_addr)) n FROM bnb_pair_trades t
    WHERE t.pair = ? AND t.side = 'buy' AND t.at < ? AND lower(t.to_addr) IN (SELECT addr FROM bnb_ring_candidates GROUP BY addr HAVING COUNT(DISTINCT pair) >= ?)`)
    .get(pair.toLowerCase(), beforeAt, RING_MIN_PAIRS) as { n: number }).n;
}

export function ringSize(db: DB): number {
  return (db.prepare("SELECT COUNT(*) n FROM (SELECT addr FROM bnb_ring_candidates GROUP BY addr HAVING COUNT(DISTINCT pair) >= ?)").get(RING_MIN_PAIRS) as { n: number }).n;
}
