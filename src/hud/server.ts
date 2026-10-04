import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DB } from "../db/index.js";
import type { Config } from "../config.js";
import { hudSummary, hudPositions, hudFeed } from "./data.js";
import { log } from "../logger.js";

/**
 * HUD webszerver (2026-10-04): csak olvas; a bot folyamatában fut. Végpontok: / (az oldal), /api/summary, /api/positions, /api/feed.
 * Titkot nem ad ki (a tárcának csak az egyenlegét). Ha a .env-ben HUD_TOKEN van, minden kéréshez ?t=<token> kell.
 * Elérés: helyi hálón http://<mini-IP>:<port>; kívülről javasolt Tailscale (nem kell portot nyitni).
 */
export function startHud(o: { db: DB; cfg: Config; port: number; host: string; token?: string }): http.Server {
  const page = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.html");
  const since = () => Date.parse(`${o.cfg.alerts.since}T00:00:00Z`);
  const srv = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://hud");
      if (o.token && url.searchParams.get("t") !== o.token) { res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }); res.end("hozzáférés megtagadva"); return; }
      const json = (x: unknown) => { res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(x)); };
      if (url.pathname === "/api/summary") return json(hudSummary(o.db, o.cfg, since()));
      if (url.pathname === "/api/positions") return json(hudPositions(o.db, o.cfg, since()));
      if (url.pathname === "/api/feed") return json(hudFeed(o.db, o.cfg, since()));
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:" });
        res.end(fs.readFileSync(page)); return;
      }
      res.writeHead(404); res.end();
    } catch (e) { log.warn("HUD hiba", { error: (e as Error).message.slice(0, 160) }); res.writeHead(500); res.end(); }
  });
  srv.listen(o.port, o.host, () => log.info(`HUD fut: http://${o.host === "0.0.0.0" ? "<mini-IP>" : o.host}:${o.port}${o.token ? " (tokennel)" : ""}`));
  return srv;
}
