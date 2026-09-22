import { redact } from "./env.js";

type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = (process.env.LOG_LEVEL as Level) ?? "info";

function fmt(level: Level, msg: string, data?: unknown): string {
  const ts = new Date().toISOString();
  let extra = "";
  if (data !== undefined) {
    try { extra = " " + JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v)); }
    catch { extra = " [unserializable]"; }
  }
  return redact(`${ts} ${level.toUpperCase().padEnd(5)} ${msg}${extra}`);
}

export const log = {
  debug: (m: string, d?: unknown) => { if (order.debug >= order[min]) console.debug(fmt("debug", m, d)); },
  info: (m: string, d?: unknown) => { if (order.info >= order[min]) console.info(fmt("info", m, d)); },
  warn: (m: string, d?: unknown) => { if (order.warn >= order[min]) console.warn(fmt("warn", m, d)); },
  error: (m: string, d?: unknown) => { console.error(fmt("error", m, d)); },
};
