import { loadConfig } from "./config.js";
import { loadEnv } from "./env.js";
import { openDb, ensureDailyState, ensureCompoundState, logEvent, openPositions } from "./db/index.js";
import { JevClient } from "./jev/client.js";
import { Telegram } from "./telegram.js";
import { publicClient, type ChainKey } from "./chains/index.js";
import { stopFileExists, createStopFile, removeStopFile } from "./killswitch.js";
import { log } from "./logger.js";
import { privateKeyToAccount } from "viem/accounts";
import { ChainWatcher } from "./watchers/index.js";

/**
 * Főprogram – 1. lépés: váz. Indul, ellenőrzi a configot/env-et, megnyitja a DB-t,
 * visszaolvassa az állapotot, Telegramon jelez, és várja a parancsokat.
 * A tokenfigyelés (2.), végrehajtás (5.) stb. később csatlakozik ide.
 */
async function main() {
  const cfg = loadConfig();
  const env = loadEnv(); // privát kulcs nélkül nem indul (4. pont)
  const db = openDb(cfg.db.path);

  const account = privateKeyToAccount(env.WALLET_PRIVATE_KEY as `0x${string}`);
  const daily = ensureDailyState(db);
  const compound = ensureCompoundState(db, cfg.risk.deposit_cap_usd, cfg.risk.base_position_usd);
  const open = openPositions(db, "live");

  const jev = new JevClient(db, cfg, env.TYPESAFE_API_KEY);
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, cfg.telegram.poll_interval_ms);

  const rpc: Record<ChainKey, string> = { base: env.BASE_RPC_URL, robinhood: env.ROBINHOOD_RPC_URL };
  const chainStatus: string[] = [];
  for (const key of ["base", "robinhood"] as ChainKey[]) {
    if (!cfg.chains[key].enabled) continue;
    try {
      const c = publicClient(key, rpc[key]);
      const [bn, bal] = await Promise.all([c.getBlockNumber(), c.getBalance({ address: account.address })]);
      chainStatus.push(`${key}: blokk ${bn}, egyenleg ${(Number(bal) / 1e18).toFixed(5)} ETH`);
    } catch (e) {
      chainStatus.push(`${key}: RPC hiba (${(e as Error).message.slice(0, 80)})`);
    }
  }

  // 2. lépés: tokenfigyelés láncenként
  const watchers: ChainWatcher[] = [];
  for (const key of ["base", "robinhood"] as ChainKey[]) {
    if (!cfg.chains[key].enabled) continue;
    const w = new ChainWatcher(key, publicClient(key, rpc[key]), db, {
      pollIntervalMs: cfg.watcher[key].poll_interval_ms,
      maxBlockRange: cfg.watcher[key].max_block_range,
      confirmations: cfg.watcher[key].confirmations,
      enabledSources: cfg.watcher[key].sources,
    });
    watchers.push(w);
    void w.start();
  }
  const tokenCounts = () => db.prepare("SELECT chain, launchpad, COUNT(*) n FROM tokens WHERE discovered_at > ? GROUP BY chain, launchpad")
    .all(Date.now() - 24 * 3600 * 1000) as { chain: string; launchpad: string; n: number }[];

  const status = () => [
    `Jev Sniper – ${cfg.mode}`,
    `wallet: ${account.address}`,
    ...chainStatus,
    `nyitott élő pozíciók: ${open.length}`,
    `ma: belépés ${daily.entries}/${cfg.risk.max_entries_per_day}, PnL ${daily.realized_pnl_usd.toFixed(2)} USD, Jev-költség ${jev.dailyCostUsd().toFixed(4)} USD`,
    `compound: betét ${compound.deposit_usd}, kassza ${compound.growth_pool_usd.toFixed(2)}, tartalék ${compound.reserve_usd.toFixed(2)}, pozícióméret ${compound.position_usd.toFixed(2)} USD`,
    `tokenek (24h): ${tokenCounts().map((r) => `${r.chain}/${r.launchpad}=${r.n}`).join(", ") || "még nincs"}`,
    `watcher: ${watchers.map((w) => `${w.stats.lastBlock} blokk, ${w.stats.tokens} token, ${w.stats.errors} hiba`).join(" | ")}`,
    `STOP fájl: ${stopFileExists() ? "AKTÍV (nincs új belépés)" : "nincs"}`,
    `Jev: ${jev.paused ? "szünetel" : "ok"}`,
  ].join("\n");

  log.info("Indulás", { mode: cfg.mode, wallet: account.address, openPositions: open.length });
  logEvent(db, "start", `mode=${cfg.mode}`);
  if (cfg.telegram.enabled) await tg.send("🟢 " + status());

  tg.onCommand(async (cmd) => {
    switch (cmd) {
      case "status": return status();
      case "stop": createStopFile("telegram /stop"); logEvent(db, "stop", "telegram"); return "⛔ STOP: nincs új belépés. /resume old fel.";
      case "resume": removeStopFile(); logEvent(db, "resume", "telegram"); return "▶️ STOP feloldva.";
      case "panic": logEvent(db, "panic", "telegram"); createStopFile("telegram /panic");
        return "🚨 PANIC fogadva. (A tényleges eladás az 5. lépésben – végrehajtási modul – kerül be.)";
      case "help": return "/status /stop /resume /panic";
    }
  });

  const shutdown = async (sig: string) => {
    log.info("Leállás", { sig });
    logEvent(db, "shutdown", sig);
    tg.stopPolling();
    watchers.forEach((w) => w.stop());
    if (cfg.telegram.enabled) await tg.send(`🔴 Bot leáll (${sig})`);
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  if (cfg.telegram.enabled) await tg.startPolling();
}

main().catch((e) => { log.error("Végzetes hiba", { error: (e as Error).message }); process.exit(1); });
