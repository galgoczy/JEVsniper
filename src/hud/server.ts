import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { DB } from "../db/index.js";
import type { Config } from "../config.js";
import { hudSummary, hudPositions, hudFeed } from "./data.js";
import { HudAuth, CSP } from "./auth.js";
import { log } from "../logger.js";

/**
 * HUD webszerver (2026-10-04): csak olvas; a bot folyamatában fut. Végpontok: / (az oldal), /login, /auth/*, /api/summary, /api/positions, /api/feed.
 * Beléptetés: jelszó (HUD_PASSWORD_HASH) → passkey (lásd auth.ts). Titkot nem ad ki (a tárcának csak az egyenlegét).
 * Nyilvános elérés: Cloudflare Tunnel (tradehud.zentopia.hu) – ilyenkor `hud.host: 127.0.0.1`.
 */
export function startHud(o: { db: DB; cfg: Config; port: number; host: string; token?: string; passwordHash?: string }): http.Server {
  const page = path.join(import.meta.dirname, "index.html");
  const since = () => Date.parse(`${o.cfg.alerts.since}T00:00:00Z`);
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
        if (url.pathname === "/api/summary") return json(hudSummary(o.db, o.cfg, since()));
        if (url.pathname === "/api/positions") return json(hudPositions(o.db, o.cfg, since()));
        if (url.pathname === "/api/feed") return json(hudFeed(o.db, o.cfg, since()));
        if (url.pathname === "/" || url.pathname === "/index.html") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": CSP });
          res.end(fs.readFileSync(page)); return;
        }
        res.writeHead(404); res.end();
      } catch (e) { log.warn("HUD hiba", { error: (e as Error).message.slice(0, 160) }); if (!res.headersSent) res.writeHead(500); res.end(); }
    })();
  });
  srv.listen(o.port, o.host, () => log.info(`HUD fut: http://${o.host === "0.0.0.0" ? "<mini-IP>" : o.host}:${o.port}`));
  return srv;
}
