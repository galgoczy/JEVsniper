import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/index.js";
import { loadConfig } from "../src/config.js";
import { hudSummary, hudPositions, hudFeed } from "../src/hud/data.js";
import { startHud } from "../src/hud/server.js";

const cfg = loadConfig("config.yaml");

function seed(file = ":memory:") {
  const db = openDb(file);
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
  assert.equal(p.length, 1);                                        // csak a Base v2 (+ BNB) – a Robinhood pregrad a buborékban látszik (2026-10-07)
  assert.ok(!p.some((x) => x.symbol === "PREG"));
  const nyitva = p.find((x) => x.symbol === "NYITVA")!; assert.ok(Math.abs((nyitva.nowX as number) - 2.5) < 1e-9);
  const f = hudFeed(db, cfg, since);
  assert.ok(f.some((e) => e.kind === "open")); assert.ok(f.some((e) => e.kind === "close" && e.reason === "moon_20x"));
  db.close();
});

test("HUD szerver: belépés nélkül 401 / átirányítás; jelszóval munkamenet; hibás jelszónál korlát; passkey csak az engedélyezett eredeten", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hud-")), "t.db");
  const { db } = seed(file);                                    // a HUD-szál ezt a fájlt olvassa (csak olvasó kapcsolattal)
  const { hashPassword } = await import("../src/hud/auth.js");
  // értékelési időszakok nélkül (a mintaadat 10-04-i; a 2. időszak 10-07 22:00 UTC-kor indult)
  const c2 = { ...cfg, db: { ...cfg.db, path: file }, evaluation: { ...cfg.evaluation, periods: [] }, hud: { ...cfg.hud, origins: ["https://tradehud.zentopia.hu"] } };
  const srv = startHud({ db, cfg: c2, port: 0, host: "127.0.0.1", passwordHash: hashPassword("helyes-jelszo-123") });
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const post = (u: string, b: unknown, h: Record<string, string> = {}) => fetch(base + u, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b), redirect: "manual" });
  assert.equal((await fetch(`${base}/api/summary`)).status, 401);
  const root = await fetch(`${base}/`, { redirect: "manual" }); assert.equal(root.status, 302); assert.equal(root.headers.get("location"), "/login");
  assert.equal((await fetch(`${base}/login`)).status, 200);
  const wa = await fetch(`${base}/auth/webauthn.js`); assert.equal(wa.status, 200); assert.match(await wa.text(), /SimpleWebAuthnBrowser/); // a böngészőoldali passkey-szkript kiszolgálható
  const st = await (await fetch(`${base}/auth/state`)).json() as { loggedIn: boolean; password: boolean; passkeyHere: boolean };
  assert.equal(st.loggedIn, false); assert.equal(st.password, true); assert.equal(st.passkeyHere, false); // http://127.0.0.1 nem engedélyezett passkey-eredet
  assert.equal((await post("/auth/passkey/login/options", {})).status, 400);
  assert.equal((await post("/auth/password", { password: "rossz" })).status, 401);
  const ok = await post("/auth/password", { password: "helyes-jelszo-123" }); assert.equal(ok.status, 200);
  const cookie = ok.headers.get("set-cookie")!.split(";")[0]!; assert.match(ok.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
  assert.ok(!/helyes-jelszo/.test(JSON.stringify(db.prepare("SELECT * FROM hud_sessions").all())));    // a jelszó nem kerül a DB-be
  const s = await fetch(`${base}/api/summary`, { headers: { cookie } }); assert.equal(s.status, 200); assert.equal((await s.json() as { mode: string }).mode, cfg.mode);
  const all = await fetch(`${base}/api/all?fresh=1`, { headers: { cookie } }); assert.equal(all.status, 200);
  const aj = await all.json() as { summary: { mode: string }; feed: unknown[]; computedAt: number };
  assert.equal(aj.summary.mode, cfg.mode); assert.ok(Array.isArray(aj.feed) && aj.feed.length > 0); assert.ok(aj.computedAt > 0);
  // https-eredetről (Cloudflare mögül) a passkey-kihívás belépve kérhető
  const reg = await post("/auth/passkey/register/options", {}, { cookie, "x-forwarded-proto": "https", "x-forwarded-host": "tradehud.zentopia.hu" });
  assert.equal(reg.status, 200); assert.equal(((await reg.json()) as { rp: { id: string } }).rp.id, "tradehud.zentopia.hu");
  assert.equal((await post("/auth/passkey/register/options", {}, { "x-forwarded-proto": "https", "x-forwarded-host": "tradehud.zentopia.hu" })).status, 401); // belépés nélkül nem
  // kilépés után a munkamenet érvénytelen
  assert.equal((await post("/auth/logout", {}, { cookie })).status, 200);
  assert.equal((await fetch(`${base}/api/summary`, { headers: { cookie } })).status, 401);
  // hibás jelszó: IP-nként 15 percenként legfeljebb 5
  for (let i = 0; i < 4; i++) await post("/auth/password", { password: "rossz" }, { "cf-connecting-ip": "9.9.9.9" });
  assert.equal((await post("/auth/password", { password: "rossz" }, { "cf-connecting-ip": "9.9.9.9" })).status, 401);
  assert.equal((await post("/auth/password", { password: "helyes-jelszo-123" }, { "cf-connecting-ip": "9.9.9.9" })).status, 429);
  assert.equal((await post("/auth/password", { password: "helyes-jelszo-123" }, { "cf-connecting-ip": "8.8.8.8" })).status, 200);
  srv.closeAllConnections(); // a fetch életben tartott kapcsolatai különben a close-t percekig várakoztatják
  await new Promise((r) => srv.close(r)); db.close();
});

test("HUD jelszó: scrypt-lenyomat ellenőrzés; jelszó kikapcsolása csak passkey mellett", async () => {
  const { hashPassword, verifyPassword, HudAuth } = await import("../src/hud/auth.js");
  const h = hashPassword("abc-def-ghi-123");
  assert.ok(h.startsWith("scrypt$")); assert.equal(verifyPassword("abc-def-ghi-123", h), true); assert.equal(verifyPassword("abc-def-ghi-124", h), false);
  assert.notEqual(hashPassword("abc-def-ghi-123"), h); // só miatt más
  const db = openDb(":memory:");
  const a = new HudAuth({ db, passwordHash: h, passwordLogin: false, origins: [] });
  assert.equal(a.passwordEnabled(), true);                       // nincs passkey → nem zárjuk ki
  db.prepare("INSERT INTO hud_passkeys(id, public_key, counter, created_at) VALUES ('x', x'00', 0, 0)").run();
  assert.equal(a.passwordEnabled(), false);                      // van passkey → kikapcsol
  db.close();
});

test("HUD nagy nyerők: tokenenként a legjobb kar, csak nyerők, koncentráció az élő karra", async () => {
  const { hudWinners } = await import("../src/hud/data.js");
  const { db } = seed();
  const w = hudWinners(db, cfg, Date.parse("2026-10-01T00:00:00Z"));
  assert.equal(w.list.length, 1); assert.equal(w.list[0]!.pnl, 3); assert.deepEqual(new Set(w.list[0]!.arms), new Set(["v2 strict", "v2"]));
  assert.equal(w.live.n, 1); assert.equal(w.live.total, 3); assert.equal(w.live.top5, 3); assert.equal(w.live.withoutTop5, 0);
  db.close();
});
