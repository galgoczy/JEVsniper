import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/index.js";
import { loadConfig } from "../src/config.js";
import { hudSummary, hudPositions, hudFeed } from "../src/hud/data.js";
import { startHud } from "../src/hud/server.js";

const cfg = loadConfig("config.yaml");

function seed() {
  const db = openDb(":memory:");
  const w = cfg.evaluation.live_window_sec, now = Date.parse("2026-10-04T12:00:00Z");
  const tok = db.prepare("INSERT INTO tokens(id, chain, address, creator, launchpad, mechanics, discovered_at, symbol) VALUES (?,?,?,?,?,?,?,?)");
  const pos = db.prepare(`INSERT INTO positions(token_id, chain, arm, exit_plan, window_sec, opened_at, entry_price_native, size_usd, size_native, tokens_bought, tokens_remaining, phase, closed_at, close_reason, net_pnl_usd, last_price_native, peak_price_native)
    VALUES (?,?,?,'live',?,?,1,1,0.0004,1,?,?,?,?,?,?,?)`);
  tok.run(1, "base", "0x1", "0xc", "uniswap", "v4", 0, "<img src=x onerror=alert(1)>");
  tok.run(2, "base", "0x2", "0xc", "uniswap", "v4", 0, "NYITVA");
  tok.run(3, "robinhood", "0x3", "0xc", "pons", "bonding_curve", 0, "PREG");
  pos.run(1, "base", cfg.live_entry.arm, w, now - 3 * 3600_000, 0, "closed", now - 3600_000, "moon_20x", 3.0, null, 20);
  pos.run(1, "base", "rule_v2", w, now - 3 * 3600_000, 0, "closed", now - 3600_000, "moon_20x", 3.0, null, 20);
  pos.run(2, "base", cfg.live_entry.arm, w, now - 600_000, 0.5, "post_tp1", null, null, null, 2.5, 3);
  pos.run(3, "robinhood", "pons_pregrad_50", 0, now - 300_000, 1, "pre_tp1", null, null, null, 1.2, 1.3);
  db.prepare("INSERT INTO fills(position_id, chain, kind, is_live, at, status, real_price_native) VALUES (1,'base','sell',0,?,'simulated',20)").run(now - 3600_000);
  return { db, now };
}

test("HUD adatok: élő kar Base-eredménye, nyitott pozíciók tokenenként, kötésfolyam", () => {
  const { db, now } = seed();
  const since = Date.parse("2026-10-01T00:00:00Z");
  const s = hudSummary(db, cfg, since, now);
  assert.equal(s.pnl.n, 1); assert.ok(Math.abs(s.pnl.realized - 3) < 1e-9); assert.equal(s.pnl.openPositions, 1);
  assert.equal(s.live.arm, cfg.live_entry.arm); assert.equal(s.decision.need, 100);
  const base = s.base.find((r) => r.arm === cfg.live_entry.arm)!; assert.equal(base.n, 1); assert.equal(base.open, 1);
  const p = hudPositions(db, cfg, since, now);
  assert.equal(p.length, 2);                                        // a nyitott Base-token és a pregrad-token
  assert.ok(p.some((x) => x.symbol === "PREG" && (x.arms as string[]).includes("pregrad 50")));
  const nyitva = p.find((x) => x.symbol === "NYITVA")!; assert.ok(Math.abs((nyitva.nowX as number) - 2.5) < 1e-9);
  const f = hudFeed(db, cfg, since);
  assert.ok(f.some((e) => e.kind === "open")); assert.ok(f.some((e) => e.kind === "close" && e.reason === "moon_20x"));
  db.close();
});

test("HUD szerver: JSON végpontok; token esetén nélküle 401", async () => {
  const { db } = seed();
  const srv = startHud({ db, cfg, port: 0, host: "127.0.0.1", token: "titok" });
  await new Promise((r) => srv.once("listening", r));
  const port = (srv.address() as { port: number }).port;
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/summary`)).status, 401);
  const r = await fetch(`http://127.0.0.1:${port}/api/summary?t=titok`); assert.equal(r.status, 200);
  const j = await r.json() as { mode: string }; assert.equal(j.mode, cfg.mode);
  const page = await fetch(`http://127.0.0.1:${port}/?t=titok`); assert.equal(page.status, 200); assert.match(await page.text(), /Jev Sniper/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/nincs?t=titok`)).status, 404);
  await new Promise((r) => srv.close(r)); db.close();
});
