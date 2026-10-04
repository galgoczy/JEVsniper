import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type http from "node:http";
import {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
  type RegistrationResponseJSON, type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import type { DB } from "../db/index.js";
import { log } from "../logger.js";

/**
 * HUD beléptetés (2026-10-04): jelszó (scrypt-lenyomat a .env-ben: HUD_PASSWORD_HASH, `npm run hud:jelszo`), majd passkey (WebAuthn).
 * Ha van legalább egy passkey és a config `hud.password_login: false`, a jelszavas belépés kikapcsol (passkey nélkül nem kapcsolható ki).
 * Munkamenet: véletlen 32 bájtos süti (hud_s), az adatbázisban csak a SHA-256 lenyomata; 30 nap. Hibás jelszó: IP-nként 15 percenként
 * legfeljebb 5, összesen óránként 30 (429). A passkey csak HTTPS-en (vagy localhoston) működik – a megengedett eredetek a configban.
 */
export interface HudAuthOpts { db: DB; passwordHash?: string; passwordLogin: boolean; origins: string[]; legacyToken?: string; rpName?: string; now?: () => number }

const SESSION_DAYS = 30, CHALLENGE_MS = 5 * 60_000;
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");

/** scrypt-lenyomat: scrypt$N$r$p$salt$hash (base64url). */
export function hashPassword(pw: string, salt = crypto.randomBytes(16)): string {
  const N = 1 << 15, r = 8, p = 1;
  const h = crypto.scryptSync(pw, salt, 32, { N, r, p, maxmem: 128 * N * r * 2 });
  return `scrypt$${N}$${r}$${p}$${b64u(salt)}$${b64u(h)}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const parts = stored.split("$"); if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  const salt = Buffer.from(parts[4]!, "base64url"), want = Buffer.from(parts[5]!, "base64url");
  const got = crypto.scryptSync(pw, salt, want.length, { N, r, p, maxmem: 128 * N * r * 2 });
  return crypto.timingSafeEqual(got, want);
}

const cookieOf = (req: http.IncomingMessage, name: string) => {
  for (const c of (req.headers.cookie ?? "").split(";")) { const [k, ...v] = c.trim().split("="); if (k === name) return decodeURIComponent(v.join("=")); }
  return null;
};
const reqOrigin = (req: http.IncomingMessage) => `${String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0]!.trim()}://${req.headers["x-forwarded-host"] ?? req.headers.host ?? ""}`;
const clientIp = (req: http.IncomingMessage) => String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "?");

export class HudAuth {
  private challenges = new Map<string, { challenge: string; kind: "reg" | "login"; exp: number }>();
  private fails = new Map<string, number[]>();
  private allFails: number[] = [];
  constructor(private o: HudAuthOpts) {}
  private now() { return (this.o.now ?? Date.now)(); }
  private passkeys() { return this.o.db.prepare("SELECT id, public_key, counter, transports FROM hud_passkeys").all() as Array<{ id: string; public_key: Buffer; counter: number; transports: string | null }>; }
  /** Jelszavas belépés engedélyezett-e: kell lenyomat; és ha a config kikapcsolja, csak akkor tilt, ha már van passkey (kizárás ellen). */
  passwordEnabled() { return !!this.o.passwordHash && (this.o.passwordLogin || this.passkeys().length === 0); }
  private rp(req: http.IncomingMessage): { origin: string; rpID: string } | null {
    const origin = reqOrigin(req);
    return this.o.origins.includes(origin) ? { origin, rpID: new URL(origin).hostname } : null;
  }

  /** Érvényes munkamenet vagy (régi) token. */
  check(req: http.IncomingMessage, url: URL): boolean {
    if (this.o.legacyToken && url.searchParams.get("t") === this.o.legacyToken) return true;
    const s = cookieOf(req, "hud_s"); if (!s) return false;
    const row = this.o.db.prepare("SELECT expires_at FROM hud_sessions WHERE token_hash = ?").get(sha(s)) as { expires_at: number } | undefined;
    return !!row && row.expires_at > this.now();
  }

  private newSession(req: http.IncomingMessage, res: http.ServerResponse, method: string) {
    const tok = crypto.randomBytes(32).toString("base64url"), exp = this.now() + SESSION_DAYS * 86_400_000;
    this.o.db.prepare("INSERT INTO hud_sessions(token_hash, created_at, expires_at, method, ip) VALUES (?,?,?,?,?)").run(sha(tok), this.now(), exp, method, clientIp(req));
    this.o.db.prepare("DELETE FROM hud_sessions WHERE expires_at < ?").run(this.now());
    const secure = reqOrigin(req).startsWith("https://") ? "; Secure" : "";
    res.setHeader("set-cookie", `hud_s=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  }
  private setChallenge(req: http.IncomingMessage, res: http.ServerResponse, challenge: string, kind: "reg" | "login") {
    const id = crypto.randomBytes(16).toString("base64url");
    for (const [k, v] of this.challenges) if (v.exp < this.now()) this.challenges.delete(k);
    this.challenges.set(id, { challenge, kind, exp: this.now() + CHALLENGE_MS });
    const secure = reqOrigin(req).startsWith("https://") ? "; Secure" : "";
    res.setHeader("set-cookie", `hud_c=${id}; Path=/auth; HttpOnly; SameSite=Strict; Max-Age=300${secure}`);
  }
  private takeChallenge(req: http.IncomingMessage, kind: "reg" | "login") {
    const id = cookieOf(req, "hud_c"); if (!id) return null;
    const c = this.challenges.get(id); this.challenges.delete(id);
    return c && c.kind === kind && c.exp > this.now() ? c.challenge : null;
  }
  private limited(ip: string) {
    const t = this.now(), mine = (this.fails.get(ip) ?? []).filter((x) => t - x < 15 * 60_000);
    this.fails.set(ip, mine); this.allFails = this.allFails.filter((x) => t - x < 3600_000);
    return mine.length >= 5 || this.allFails.length >= 30;
  }
  private fail(ip: string) { const t = this.now(); (this.fails.get(ip) ?? this.fails.set(ip, []).get(ip)!).push(t); this.allFails.push(t); }

  /** Az /auth/* és /login útvonalak kezelése. true = kezelve. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    const json = (code: number, x: unknown) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(x)); return true; };
    if (p === "/login") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": CSP });
      res.end(fs.readFileSync(path.join(import.meta.dirname, "login.html"))); return true;
    }
    if (p === "/auth/webauthn.js") {
      const req2 = createRequire(import.meta.url), file = path.join(path.dirname(req2.resolve("@simplewebauthn/browser/package.json")), "dist/bundle/index.umd.min.js");
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "max-age=86400" }); res.end(fs.readFileSync(file)); return true;
    }
    if (!p.startsWith("/auth/")) return false;
    if (req.method === "GET" && p === "/auth/state") return json(200, { loggedIn: this.check(req, url), password: this.passwordEnabled(), passkeys: this.passkeys().length, passkeyHere: !!this.rp(req) });
    if (req.method !== "POST" || !String(req.headers["content-type"] ?? "").startsWith("application/json")) return json(405, { error: "csak JSON POST" });
    const body = await readJson(req).catch(() => null);
    if (body === null) return json(400, { error: "hibás kérés" });
    const ip = clientIp(req);

    if (p === "/auth/logout") {
      const s = cookieOf(req, "hud_s"); if (s) this.o.db.prepare("DELETE FROM hud_sessions WHERE token_hash = ?").run(sha(s));
      res.setHeader("set-cookie", "hud_s=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"); return json(200, { ok: true });
    }
    if (p === "/auth/password") {
      if (!this.passwordEnabled()) return json(403, { error: "a jelszavas belépés ki van kapcsolva – passkey-vel lépj be" });
      if (this.limited(ip)) return json(429, { error: "túl sok próbálkozás, várj 15 percet" });
      const pw = typeof (body as { password?: unknown }).password === "string" ? (body as { password: string }).password : "";
      if (!pw || !verifyPassword(pw, this.o.passwordHash!)) { this.fail(ip); log.warn("HUD: hibás jelszó", { ip }); return json(401, { error: "hibás jelszó" }); }
      this.newSession(req, res, "password"); return json(200, { ok: true });
    }
    const rp = this.rp(req);
    if (p === "/auth/passkey/login/options") {
      if (!rp) return json(400, { error: "passkey csak a beállított HTTPS címen működik" });
      const opts = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "preferred", allowCredentials: this.passkeys().map((k) => ({ id: k.id, transports: k.transports ? JSON.parse(k.transports) : undefined })) });
      this.setChallenge(req, res, opts.challenge, "login"); return json(200, opts);
    }
    if (p === "/auth/passkey/login/verify") {
      if (!rp) return json(400, { error: "passkey csak a beállított HTTPS címen működik" });
      if (this.limited(ip)) return json(429, { error: "túl sok próbálkozás, várj 15 percet" });
      const resp = body as AuthenticationResponseJSON, ch = this.takeChallenge(req, "login");
      const key = this.passkeys().find((k) => k.id === resp.id);
      if (!ch || !key) { this.fail(ip); return json(401, { error: "ismeretlen passkey vagy lejárt kihívás" }); }
      try {
        const v = await verifyAuthenticationResponse({ response: resp, expectedChallenge: ch, expectedOrigin: rp.origin, expectedRPID: rp.rpID,
          credential: { id: key.id, publicKey: new Uint8Array(key.public_key), counter: key.counter, transports: key.transports ? JSON.parse(key.transports) : undefined } });
        if (!v.verified) { this.fail(ip); return json(401, { error: "sikertelen ellenőrzés" }); }
        this.o.db.prepare("UPDATE hud_passkeys SET counter = ?, last_used_at = ? WHERE id = ?").run(v.authenticationInfo.newCounter, this.now(), key.id);
        this.newSession(req, res, "passkey"); return json(200, { ok: true });
      } catch (e) { this.fail(ip); return json(401, { error: (e as Error).message.slice(0, 120) }); }
    }
    // innentől csak belépve (passkey felvétele)
    if (!this.check(req, url)) return json(401, { error: "előbb lépj be" });
    if (p === "/auth/passkey/register/options") {
      if (!rp) return json(400, { error: "passkey csak a beállított HTTPS címen vehető fel" });
      const opts = await generateRegistrationOptions({ rpName: this.o.rpName ?? "Jev Sniper HUD", rpID: rp.rpID, userName: "hud", userDisplayName: "Jev Sniper HUD",
        userID: new TextEncoder().encode("jev-sniper-hud-owner"), attestationType: "none", authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
        excludeCredentials: this.passkeys().map((k) => ({ id: k.id, transports: k.transports ? JSON.parse(k.transports) : undefined })) });
      this.setChallenge(req, res, opts.challenge, "reg"); return json(200, opts);
    }
    if (p === "/auth/passkey/register/verify") {
      if (!rp) return json(400, { error: "passkey csak a beállított HTTPS címen vehető fel" });
      const ch = this.takeChallenge(req, "reg"); if (!ch) return json(400, { error: "lejárt kihívás, próbáld újra" });
      try {
        const v = await verifyRegistrationResponse({ response: body as RegistrationResponseJSON, expectedChallenge: ch, expectedOrigin: rp.origin, expectedRPID: rp.rpID });
        if (!v.verified) return json(400, { error: "sikertelen ellenőrzés" });
        const c = v.registrationInfo.credential, label = String((body as { label?: unknown }).label ?? "").slice(0, 40) || `passkey ${new Date(this.now()).toLocaleDateString("hu-HU")}`;
        this.o.db.prepare("INSERT OR REPLACE INTO hud_passkeys(id, public_key, counter, transports, label, created_at) VALUES (?,?,?,?,?,?)")
          .run(c.id, Buffer.from(c.publicKey), c.counter, c.transports ? JSON.stringify(c.transports) : null, label, this.now());
        log.info("HUD: új passkey felvéve", { label });
        return json(200, { ok: true, passkeys: this.passkeys().length });
      } catch (e) { return json(400, { error: (e as Error).message.slice(0, 120) }); }
    }
    return json(404, { error: "ismeretlen" });
  }
}

export const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'";

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > 64 * 1024) throw new Error("túl nagy"); chunks.push(c as Buffer); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
