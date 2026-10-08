import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import type { DB } from "../db/index.js";
import type { Config } from "../config.js";
import { hudSummary, hudPositions, hudFeed, hudWinners, hudPeriods, hudBnbLive, hudBaseLive } from "./data.js";
import { currentSince } from "../analysis/periods.js";

/**
 * HUD adat-szál (2026-10-06): a HUD lekérdezései (750 ezer soros pozíció-tábla, ~20 mp) a bot fő szálát akasztották meg.
 * Itt külön szálon, saját, csak olvasó adatbázis-kapcsolattal (WAL) futnak; a fő szál csak a kész JSON-t kapja meg.
 */
const { dbPath, cfg } = workerData as { dbPath: string; cfg: Config };
const db = new Database(dbPath, { readonly: true, fileMustExist: true }) as unknown as DB;
db.pragma("busy_timeout = 5000");
const since = () => currentSince(cfg);

parentPort!.on("message", (msg: { id: number; kind?: "all" | "live" }) => {
  // 2026-10-08: a gyors (5 mp-es) élő-blokk csak az olcsó élő lekérdezéseket futtatja (Base + BNB)
  if (msg.kind === "live") {
    try { parentPort!.postMessage({ id: msg.id, data: { bnbLive: hudBnbLive(db, cfg), baseLive: hudBaseLive(db, cfg), computedAt: Date.now() } }); }
    catch (e) { parentPort!.postMessage({ id: msg.id, error: (e as Error).message.slice(0, 200) }); }
    return;
  }
  try {
    const s = since(), t = Date.now();
    const data = { summary: hudSummary(db, cfg, s), positions: hudPositions(db, cfg, s), feed: hudFeed(db, cfg, s), winners: hudWinners(db, cfg, s), periods: hudPeriods(db, cfg), computedAt: Date.now(), tookMs: 0 };
    data.tookMs = Date.now() - t;
    parentPort!.postMessage({ id: msg.id, data });
  } catch (e) {
    parentPort!.postMessage({ id: msg.id, error: (e as Error).message.slice(0, 200) });
  }
});
