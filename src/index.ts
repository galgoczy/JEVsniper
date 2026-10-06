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
import { Collector, CollectorScheduler, EthPrice, tokenRow, type TokenRow } from "./collector/index.js";
import { applyHardFilters } from "./filters/index.js";
import { Executor } from "./exec/executor.js";
import { routeFor } from "./exec/routes.js";
import { rpcUrls } from "./chains/index.js";
import { RegimeGate } from "./decision/regime.js";
import { DecisionEngine } from "./decision/engine.js";
import { PriceFeed } from "./exit/pricefeed.js";
import { PositionMonitor } from "./exit/monitor.js";
import { CompoundManager } from "./compound/index.js";
import { writeReport } from "./report/index.js";
import { checkArms } from "./analysis/watch.js";
import { standings, standingsCompact, reportCompact } from "./analysis/standings.js";
import { CopyTracker } from "./copy/tracker.js";
import { ListingWatcher } from "./listing/watcher.js";
import { GraduationTracker } from "./graduation/index.js";
import { currentPositionUsd, shadowSizeUsd } from "./decision/risk.js";
import { getAddress, isAddressEqual, type Address } from "viem";
import { ADDRESSES, ZERO } from "./chains/addresses.js";
import { PreGradArms } from "./graduation/pregrad.js";
import { FlipArm, FLIP_ARM } from "./graduation/flip.js";
import { BnbRecorder } from "./bnb/recorder.js";
import { PancakeRecorder } from "./bnb/pancake.js";
import { SolRecorder } from "./sol/recorder.js";
import { SolAmmRecorder } from "./sol/amm.js";
import { startHud } from "./hud/server.js";

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
  const ethPrice = new EthPrice(publicClient("base", env.BASE_RPC_URL));
  // 5. lépés: végrehajtók láncenként (küldés a privát/MEV-védett RPC-n, ha van, különben az első RPC-n)
  const executors: Partial<Record<ChainKey, Executor>> = {};
  for (const key of ["base", "robinhood"] as ChainKey[]) {
    if (!cfg.chains[key].enabled) continue;
    const sendUrl = (key === "base" ? env.BASE_PRIVATE_TX_RPC_URL : env.ROBINHOOD_PRIVATE_TX_RPC_URL) || rpcUrls(key === "base" ? env.BASE_RPC_URL : env.ROBINHOOD_RPC_URL)[0]!;
    executors[key] = new Executor(key, publicClient(key, key === "base" ? env.BASE_RPC_URL : env.ROBINHOOD_RPC_URL), db, cfg, env.WALLET_PRIVATE_KEY as `0x${string}`, sendUrl, () => ethPrice.get());
  }
  /** /panic: minden nyitott élő pozíció eladása azonnal, magas csúszással. */
  const panicSellAll = async (): Promise<string> => {
    const rows = db.prepare("SELECT t.*, p.id AS position_id, p.tokens_remaining FROM positions p JOIN tokens t ON t.id = p.token_id WHERE p.arm = 'live' AND p.closed_at IS NULL").all() as Array<TokenRow & { position_id: number; tokens_remaining: number }>;
    const out: string[] = [];
    for (const r of rows) {
      const ex = executors[r.chain as ChainKey]; if (!ex) continue;
      try {
        const route = await routeFor(ex.client, r.chain as ChainKey, r);
        const bal = await ex.tokenBalance(getAddress(r.address));
        const res = await ex.sell(route, getAddress(r.address), bal, cfg.execution.panic_slippage_pct, { positionId: r.position_id, panic: true });
        db.prepare("UPDATE positions SET tokens_remaining = ?, phase = ?, closed_at = ?, close_reason = 'panic' WHERE id = ?").run(res.unsellable ? Number(r.tokens_remaining) : 0, res.unsellable ? "unsellable" : "closed", res.unsellable ? null : Date.now(), r.position_id);
        out.push(`${r.symbol ?? r.address}: ${res.unsellable ? "NEM ELADHATÓ" : "eladva"} ${res.hash ?? ""}`);
      } catch (e) { out.push(`${r.symbol ?? r.address}: hiba ${(e as Error).message.slice(0, 80)}`); }
    }
    return out.length ? out.join("\n") : "nincs nyitott élő pozíció";
  };
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

  // 3. lépés: paramétergyűjtő (30/60/180 mp-nél pillanatkép minden új tokenről)
  const clients = { base: publicClient("base", rpc.base), robinhood: publicClient("robinhood", rpc.robinhood) };
  const collector = new Collector(db, clients, ethPrice);
  // 6. lépés: rezsim-kapu (óránként) + döntési motor
  const regime = new RegimeGate(db, cfg, jev, () => ethPrice.get(), async () => ({
    base: cfg.chains.base.enabled ? Number(await clients.base.getGasPrice().catch(() => 0)) / 1e9 : null,
    robinhood: cfg.chains.robinhood.enabled ? Number(await clients.robinhood.getGasPrice().catch(() => 0)) / 1e9 : null,
  }));
  const engine = new DecisionEngine({ db, cfg, jev, regime, executors, ethUsd: () => ethPrice.get(), notify: (m) => (cfg.telegram.enabled ? tg.send(m) : Promise.resolve(false)) });
  await regime.refresh(true).catch((e) => log.warn("rezsim init hiba", { error: (e as Error).message }));
  // 7. lépés: tartás-figyelés, kiszállás (élő + árnyék), 24 órás kimenet-követés
  const feeds = { base: new PriceFeed("base", clients.base, db), robinhood: new PriceFeed("robinhood", clients.robinhood, db) };
  // 8. lépés: compound-kezelő (lezárt élő pozíciók könyvelése, napi méret-újraszámolás)
  const compoundMgr = new CompoundManager(db, cfg, (m) => (cfg.telegram.enabled ? tg.send(m) : Promise.resolve(false)));
  const compoundTimer = compoundMgr.schedule();
  // RH saját stratégia: graduáció előtti árnyékbelépés a PONS-görbéken (az árfigyelő görbe-haladásából)
  const pregrad = new PreGradArms(async (tokenId, arm, price, liq) => {
    const row = tokenRow(db, tokenId); const eth = await ethPrice.get();
    return row && typeof eth === "number" ? engine.openShadowAt(row, arm, 0, price, shadowSizeUsd(cfg), eth, liq) : 0;
  });
  // RH mérőkar: 95%-on be, graduáción ki (gyors görbe-lekérdezés 85% fölött)
  const flip = new FlipArm({ db, client: clients.robinhood, open: async (tokenId, price, liq) => {
    const row = tokenRow(db, tokenId); const eth = await ethPrice.get();
    return row && typeof eth === "number" ? engine.openShadowAt(row, FLIP_ARM, 0, price, shadowSizeUsd(cfg), eth, liq, null, ["flip", "live"]) : 0;
  } });
  if (cfg.graduation.enabled && cfg.chains.robinhood.enabled) flip.start();
  const monitor = new PositionMonitor({ db, cfg, jev, executors, feeds, ethUsd: () => ethPrice.get(), regime: () => regime.regime,
    notify: (m) => (cfg.telegram.enabled ? tg.send(m) : Promise.resolve(false)), onLiveClosed: (p) => compoundMgr.onLiveClosed(p.net_pnl_usd),
    onCurve: cfg.graduation.enabled ? async (o) => {
      const nativeQuote = !o.pairToken || isAddressEqual(o.pairToken as Address, ZERO) || isAddressEqual(o.pairToken as Address, ADDRESSES[o.chain].weth);
      await pregrad.observe({ ...o, nativeQuote });
      if (o.chain === "robinhood") await flip.observe({ ...o, nativeQuote });
    } : undefined });
  monitor.start(15_000);
  // Copy trading árnyékteszt: tárcakövetés láncenként
  const copyTrackers = (["base", "robinhood"] as ChainKey[]).filter((k) => cfg.chains[k].enabled).map((k) => new CopyTracker({ db, cfg, chain: k, client: clients[k],
    ethUsd: () => ethPrice.get(), openShadow: (t, arm, price, eth, liq) => engine.openShadowAt(t, arm, 0, price, shadowSizeUsd(cfg), eth, liq) }));
  copyTrackers.forEach((c) => c.start());
  // V2: graduációs szakasz (PONS curve → v4)
  const graduation = new GraduationTracker({ db, cfg, collect: (t, w, d) => collector.collect(t, w, d), saveSnapshot: (t, snap) => collector.saveSnapshot(t, snap, cfg.db.max_snapshot_bytes),
    openShadow: (t, arm, price, eth, liq) => engine.openShadowAt(t, arm, 0, price, shadowSizeUsd(cfg), eth, liq), ethUsd: () => ethPrice.get() });
  // Listázás-figyelő (Coinbase / Robinhood)
  const listing = new ListingWatcher({ db, cfg, notify: (m) => (cfg.telegram.enabled ? tg.send(m) : Promise.resolve(false)) });
  listing.start();
  const bnbRecorder = cfg.bnb.enabled ? new BnbRecorder({ db, rpcUrl: env.BNB_RPC_URL || undefined, pollMs: cfg.bnb.poll_ms }) : null;
  bnbRecorder?.start();
  const pcsRecorder = cfg.bnb.enabled && cfg.bnb.pancake ? new PancakeRecorder({ db, rpcUrl: env.BNB_RPC_URL || undefined, pollMs: cfg.bnb.poll_ms }) : null;
  pcsRecorder?.start();
  const solRecorder = cfg.sol.enabled ? new SolRecorder({ db, wsUrl: env.SOL_WS_URL || undefined }) : null;
  solRecorder?.start();
  const solAmm = cfg.sol.enabled && cfg.sol.amm ? new SolAmmRecorder({ db, wsUrl: env.SOL_WS_URL || undefined }) : null;
  solAmm?.start();
  const hud = cfg.hud.enabled ? startHud({ db, cfg, port: cfg.hud.port, host: cfg.hud.host, token: env.HUD_TOKEN || undefined, passwordHash: env.HUD_PASSWORD_HASH || undefined }) : null;
  // 9. lépés: napi riport (config report.daily_time_utc) + /report parancs
  // Telegram-riport (2026-10-03): időarányos + állás + visszaforgatás, telefonra; a teljes markdown riport fájlba (napi, 24 órás)
  const telegramReport = () => {
    const file = writeReport(db, cfg).file;
    return reportCompact(db, Date.parse(`${cfg.alerts.since}T00:00:00Z`), cfg) + `\nTeljes: ${file}`;
  };
  const [rh, rm] = cfg.report.daily_time_utc.split(":").map(Number) as [number, number];
  const reportTimer = setInterval(() => {
    const d = new Date();
    if (d.getUTCHours() === rh && d.getUTCMinutes() === rm) { try { void tg.send(telegramReport()); } catch (e) { log.warn("riport hiba", { error: (e as Error).message }); } }
  }, 60_000);
  // Tárca-ellenőrzés (2026-10-03): a Base-egyenleg és az ETH-ár mentése 10 percenként a meta táblába – az állás-lekérés ebből számol
  const saveWallet = async () => {
    const ex = executors.base; if (!ex) return;
    const [bal, eth] = await Promise.all([ex.nativeBalance(), ethPrice.get()]);
    if (typeof eth !== "number") return;
    const put = db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)");
    put.run("wallet_base_eth", String(Number(bal) / 1e18)); put.run("wallet_eth_usd", String(eth)); put.run("wallet_at", String(Date.now()));
  };
  void saveWallet().catch(() => undefined);
  const walletTimer = setInterval(() => void saveWallet().catch((e) => log.debug("tárca-egyenleg hiba", { error: (e as Error).message.slice(0, 100) })), 10 * 60_000);
  const regimeTimer = setInterval(() => void regime.refresh().catch(() => undefined), 60_000);
  // Futás közbeni figyelő: állapotváltáskor Telegram-üzenet (legfeljebb 6 sor egyszerre)
  const alertsSince = Date.parse(`${cfg.alerts.since}T00:00:00Z`);
  const alertTimer = setInterval(() => {
    if (!cfg.alerts.enabled) return;
    try {
      const msgs = checkArms(db, alertsSince);
      if (msgs.length) void tg.send(["📈 Árnyékstratégia-figyelő", ...msgs.slice(0, 6), ...(msgs.length > 6 ? [`…és még ${msgs.length - 6} változás (npm run report -- --since ${cfg.alerts.since})`] : [])].join("\n"));
    } catch (e) { log.warn("figyelő hiba", { error: (e as Error).message.slice(0, 160) }); }
  }, cfg.alerts.interval_min * 60_000);

  // 4. lépés: kemény szűrők minden pillanatképre; 6. lépés: döntés (élő ablakban belépés, máshol árnyék)
  const scheduler = new CollectorScheduler(db, collector, cfg.evaluation.windows_sec, cfg.db.max_snapshot_bytes, async (t, snap) => {
    const f = applyHardFilters(db, cfg, t, snap);
    await engine.onSnapshot(t, snap, f.pass);
  }, { sec: cfg.evaluation.late_window_sec, scope: cfg.evaluation.late_scope });

  // 2. lépés: tokenfigyelés láncenként
  const watchers: ChainWatcher[] = [];
  for (const key of ["base", "robinhood"] as ChainKey[]) {
    if (!cfg.chains[key].enabled) continue;
    const w = new ChainWatcher(key, clients[key], db, {
      pollIntervalMs: cfg.watcher[key].poll_interval_ms,
      maxBlockRange: cfg.watcher[key].max_block_range,
      confirmations: cfg.watcher[key].confirmations,
      enabledSources: cfg.watcher[key].sources,
      onToken: (_t, id) => { const row = tokenRow(db, id); if (row) scheduler.schedule(row); },
      onGraduation: (id, sqrt) => graduation.onGraduation(id, sqrt),
    });
    watchers.push(w);
    void w.start();
  }
  const tokenCounts = () => db.prepare("SELECT chain, launchpad, COUNT(*) n FROM tokens WHERE discovered_at > ? GROUP BY chain, launchpad")
    .all(Date.now() - 24 * 3600 * 1000) as { chain: string; launchpad: string; n: number }[];

  const status = () => [
    `Jev Sniper – ${cfg.mode}`,
    `élő kar: ${cfg.live_entry.arm} (${cfg.evaluation.live_window_sec} mp, terv ${cfg.live_entry.exit_plan})`,
    `wallet: ${account.address}`,
    ...chainStatus,
    `nyitott élő pozíciók: ${(db.prepare("SELECT COUNT(*) n FROM positions WHERE arm='live' AND closed_at IS NULL").get() as { n: number }).n}, árnyék: ${(db.prepare("SELECT COUNT(*) n FROM positions WHERE arm NOT IN ('live','day1_test') AND closed_at IS NULL").get() as { n: number }).n}, lezárt élő (24h): ${(db.prepare("SELECT COUNT(*) n, COALESCE(SUM(net_pnl_usd),0) s FROM positions WHERE arm='live' AND closed_at > ?").get(Date.now() - 86_400_000) as { n: number; s: number }).n}`,
    `ma: belépés ${daily.entries}/${cfg.risk.max_entries_per_day}, PnL ${daily.realized_pnl_usd.toFixed(2)} USD, Jev-költség ${jev.dailyCostUsd().toFixed(4)} USD`,
    `compound: betét ${compound.deposit_usd}, kassza ${compound.growth_pool_usd.toFixed(2)}, tartalék ${compound.reserve_usd.toFixed(2)}, pozícióméret ${compound.position_usd.toFixed(2)} USD`,
    `tokenek (24h): ${tokenCounts().map((r) => `${r.chain}/${r.launchpad}=${r.n}`).join(", ") || "még nincs"}`,
    `szűrőn kiesett (24h): ${(db.prepare("SELECT COUNT(DISTINCT token_id) n FROM filter_log WHERE at > ?").get(Date.now() - 86_400_000) as { n: number }).n}`,
    `pillanatképek (24h): ${(db.prepare("SELECT COUNT(*) n FROM snapshots WHERE taken_at > ?").get(Date.now() - 86_400_000) as { n: number }).n}`,
    `watcher: ${watchers.map((w) => `${w.stats.lastBlock} blokk, ${w.stats.tokens} token, ${w.stats.errors} hiba`).join(" | ")}`,
    ...(bnbRecorder ? [`BNB felvevő: ${bnbRecorder.stats.tokens} token, ${bnbRecorder.stats.trades} kötés, ${bnbRecorder.stats.grads} graduáció (indulás óta), ${bnbRecorder.stats.errors} hiba, blokk ${bnbRecorder.stats.lastBlock}`] : []),
    ...(pcsRecorder ? [`PancakeSwap felvevő: ${pcsRecorder.stats.shells} új WBNB-pár (héj), ${pcsRecorder.stats.waiting} vár likviditásra, ${pcsRecorder.stats.pairs} valódi indítás, ${pcsRecorder.stats.trades} kötés, ${pcsRecorder.stats.snapshots} pillanatkép, követett ${pcsRecorder.stats.tracked}, hiba ${pcsRecorder.stats.errors}`] : []),
    ...(solRecorder ? [`SOL felvevő: ${solRecorder.stats.tokens} token, ${solRecorder.stats.trades} kötés mentve, ${solRecorder.stats.snapshots} pillanatkép, ${solRecorder.stats.completes} görbe-teljesülés, ${solRecorder.stats.migrations} migráció, követett ${solRecorder.stats.tracked}, túlélő ${solRecorder.stats.survivors}, újracsatlakozás ${solRecorder.stats.reconnects}, hiba ${solRecorder.stats.errors}`] : []),
    ...(solAmm ? [`SOL PumpSwap felvevő: ${solAmm.stats.pools} pool (${solAmm.stats.fromMigrate} a migrációból), ${solAmm.stats.trades} kötés, ${solAmm.stats.snapshots} pillanatkép, követett ${solAmm.stats.tracked}, hiba ${solAmm.stats.errors}`] : []),
    `pillanatkép kihagyva késés miatt (indulás óta): Base ${collector.staleSkipped.base}, Robinhood ${collector.staleSkipped.robinhood}`,
    `STOP fájl: ${stopFileExists() ? "AKTÍV (nincs új belépés)" : "nincs"}`,
    `Jev: ${jev.disabled ? "kikapcsolva" : jev.paused ? "szünetel" : "ok"}, rezsim: ${regime.regime}`,
    `döntések (24h): ${(db.prepare("SELECT SUM(arm='live' AND enter=1) l, SUM(arm='live_rule' AND enter=1) lr, SUM(arm='random_control' AND enter=1) rc, COUNT(DISTINCT token_id) n FROM decisions WHERE decided_at > ?").get(Date.now() - 86_400_000) as { l: number; lr: number; rc: number; n: number }).n} token címkézve`,
  ].join("\n");

  log.info("Indulás", { mode: cfg.mode, wallet: account.address, openPositions: open.length });
  logEvent(db, "start", `mode=${cfg.mode}`);
  if (cfg.telegram.enabled) await tg.send("🟢 " + status());

  tg.onCommand(async (cmd) => {
    switch (cmd) {
      case "status": return status();
      case "stop": createStopFile("telegram /stop"); logEvent(db, "stop", "telegram"); return "⛔ STOP: nincs új belépés. /resume old fel.";
      case "resume": removeStopFile(); logEvent(db, "resume", "telegram"); return "▶️ STOP feloldva.";
      case "panic": {
        logEvent(db, "panic", "telegram"); createStopFile("telegram /panic");
        await tg.send("🚨 PANIC: STOP beállítva, minden nyitott élő pozíció eladása indul…");
        return "🚨 PANIC eredmény:\n" + (await panicSellAll());
      }
      case "report": { try { return telegramReport(); } catch (e) { return `riport hiba: ${(e as Error).message.slice(0, 120)}`; } }
      case "allas": { try { return standingsCompact(db, Date.parse(`${cfg.alerts.since}T00:00:00Z`), cfg); } catch (e) { return `állás hiba: ${(e as Error).message.slice(0, 120)}`; } }
      case "allas_reszletes": { try { return standings(db, Date.parse(`${cfg.alerts.since}T00:00:00Z`), cfg.evaluation.live_window_sec, Date.now(), cfg); } catch (e) { return `állás hiba: ${(e as Error).message.slice(0, 120)}`; } }
      case "help": return "/status /allas /report /allas_reszletes /stop /resume /panic";
    }
  });

  const shutdown = async (sig: string) => {
    log.info("Leállás", { sig });
    logEvent(db, "shutdown", sig);
    tg.stopPolling();
    watchers.forEach((w) => w.stop());
    scheduler.stop();
    clearInterval(regimeTimer);
    clearInterval(walletTimer);
    monitor.stop();
    clearInterval(compoundTimer);
    clearInterval(reportTimer);
    clearInterval(alertTimer);
    copyTrackers.forEach((c) => c.stop());
    listing.stop();
    bnbRecorder?.stop();
    pcsRecorder?.stop();
    solRecorder?.stop();
    solAmm?.stop();
    hud?.close();
    graduation.stop();
    flip.stop();
    if (cfg.telegram.enabled) await tg.send(`🔴 Bot leáll (${sig})`);
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  if (cfg.telegram.enabled) await tg.startPolling();
}

main().catch((e) => { log.error("Végzetes hiba", { error: (e as Error).message }); process.exit(1); });
