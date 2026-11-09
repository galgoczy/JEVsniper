import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { DB } from "../db/index.js";
import type { Config } from "../config.js";
import { Worker } from "node:worker_threads";
import { SystemStats } from "./system.js";
import { HudAuth, CSP } from "./auth.js";
import { log } from "../logger.js";

/**
 * HUD webszerver (2026-10-04): csak olvas; a bot folyamatában fut. Végpontok: / (az oldal), /login, /auth/*, /api/summary, /api/positions, /api/feed.
 * Beléptetés: jelszó (HUD_PASSWORD_HASH) → passkey (lásd auth.ts). Titkot nem ad ki (a tárcának csak az egyenlegét).
 * Nyilvános elérés: Cloudflare Tunnel (tradehud.zentopia.hu) – ilyenkor `hud.host: 127.0.0.1`.
 */
/** A HUD adatai a külön szálból, gyorsítótárazva: legfeljebb CACHE_MS-enként egy számítás, a „friss” kérés MIN_FRESH_MS után. */
const CACHE_MS = 30_000, MIN_FRESH_MS = 5_000;
type HudData = { summary: unknown; positions: unknown; feed: unknown; winners: unknown; computedAt: number; tookMs: number };
class HudData_ {
  private w: Worker; private seq = 0; private pending = new Map<number, (r: { data?: any; error?: string }) => void>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  private last: HudData | null = null; private inflight: Promise<HudData> | null = null;
  constructor(dbPath: string, cfg: Config) {
    const ts = import.meta.url.endsWith(".ts");
    this.w = new Worker(new URL(ts ? "./worker.ts" : "./worker.js", import.meta.url), { workerData: { dbPath, cfg } });
    this.w.on("message", (m: { id: number; data?: HudData; error?: string }) => { this.pending.get(m.id)?.(m); this.pending.delete(m.id); });
    this.w.on("error", (e: Error) => log.warn("HUD-szál hiba", { error: e.message.slice(0, 160) }));
    this.w.unref();
  }
  get(fresh: boolean): Promise<HudData> {
    const age = this.last ? Date.now() - this.last.computedAt : Infinity;
    if (this.last && (age < MIN_FRESH_MS || (!fresh && age < CACHE_MS))) return Promise.resolve(this.last);
    if (this.inflight) return this.inflight;
    const id = ++this.seq;
    this.inflight = new Promise<HudData>((resolve, reject) => this.pending.set(id, (r) => (r.data ? resolve(r.data) : reject(new Error(r.error ?? "HUD-szál hiba")))))
      .then((d) => { this.last = d; return d; }).finally(() => { this.inflight = null; });
    this.w.postMessage({ id });
    return this.inflight;
  }
  /** Gyors élő-blokk (2026-10-08): 3 mp-es gyorsítótár, külön a nehéz összesítőtől. */
  private lastLive: { data: unknown; at: number } | null = null; private liveInflight: Promise<unknown> | null = null;
  getLive(): Promise<unknown> {
    if (this.lastLive && Date.now() - this.lastLive.at < 3_000) return Promise.resolve(this.lastLive.data);
    if (this.liveInflight) return this.liveInflight;
    const id = ++this.seq;
    this.liveInflight = new Promise((resolve, reject) => this.pending.set(id, (r) => (r.data ? resolve(r.data) : reject(new Error(r.error ?? "HUD-szál hiba")))))
      .then((d) => { this.lastLive = { data: d, at: Date.now() }; return d; }).finally(() => { this.liveInflight = null; });
    this.w.postMessage({ id, kind: "live" });
    return this.liveInflight;
  }
  close() { void this.w.terminate(); }
}

export function startHud(o: { db: DB; cfg: Config; port: number; host: string; token?: string; passwordHash?: string }): http.Server {
  const page = path.join(import.meta.dirname, "index.html");
  const data = new HudData_(path.resolve(o.cfg.db.path), o.cfg);
  const sys = new SystemStats(path.resolve(o.cfg.db.path));
  const auth = new HudAuth({ db: o.db, passwordHash: o.passwordHash, passwordLogin: o.cfg.hud.password_login, origins: o.cfg.hud.origins, legacyToken: o.token });
  if (!o.passwordHash && !o.token) log.warn("HUD: nincs HUD_PASSWORD_HASH (npm run hud:jelszo) – belépni csak meglévő passkey-vel lehet");
  const srv = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://hud");
        res.setHeader("x-frame-options", "DENY"); res.setHeader("referrer-policy", "no-referrer"); res.setHeader("x-content-type-options", "nosniff");
        if (await auth.handle(req, res, url)) return;
        if (!auth.check(req, url)) {
          if (url.pathname.startsWith("/api/")) { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":"belépés szükséges"}'); return; }
          res.writeHead(302, { location: "/login" }); res.end(); return;
        }
        const json = (x: unknown) => { res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(x)); };
        if (url.pathname === "/api/all") return json({ ...(await data.get(url.searchParams.get("fresh") === "1")), system: sys.get() });
        if (url.pathname === "/api/system") return json(sys.get());
        if (url.pathname === "/api/live") return json({ ...((await data.getLive()) as object), system: sys.get() });
        const one = { "/api/summary": "summary", "/api/positions": "positions", "/api/feed": "feed", "/api/winners": "winners" }[url.pathname] as keyof HudData | undefined;
        if (one) return json((await data.get(false))[one]);
        if (url.pathname === "/" || url.pathname === "/index.html") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": CSP });
          res.end(fs.readFileSync(page)); return;
        }
        res.writeHead(404); res.end();
      } catch (e) { log.warn("HUD hiba", { error: (e as Error).message.slice(0, 160) }); if (!res.headersSent) res.writeHead(500); res.end(); }
    })();
  });
  srv.on("close", () => { data.close(); sys.stop(); });
  srv.listen(o.port, o.host, () => log.info(`HUD fut: http://${o.host === "0.0.0.0" ? "<mini-IP>" : o.host}:${o.port}`));
  return srv;
}
