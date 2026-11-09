/**
 * HUD-jelszó beállítása: npm run hud:jelszo
 * Rejtett beírással bekéri a jelszót kétszer, és a .env-be csak a scrypt-lenyomatot írja (HUD_PASSWORD_HASH=…).
 * A jelszó maga sehova nem kerül. Utána a botot újra kell indítani.
 */
import fs from "node:fs";
import readline from "node:readline";
import { hashPassword } from "../src/hud/auth.js";

function ask(q: string): Promise<string> {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    out._writeToOutput = (s: string) => { if (s.includes(q)) out.output.write(s); else out.output.write(s.replace(/[^\r\n]/g, "•")); };
    rl.question(q, (a) => { rl.close(); process.stdout.write("\n"); res(a); });
  });
}
if (!process.stdin.isTTY) { console.log("❌ Ezt a parancsot a terminálban, kézzel futtasd (rejtett jelszó-beírás kell)."); process.exit(1); }
const a = await ask("Új HUD-jelszó (legalább 12 karakter): ");
if (a.length < 12) { console.log("❌ Túl rövid (legalább 12 karakter)."); process.exit(1); }
const b = await ask("Még egyszer: ");
if (a !== b) { console.log("❌ A két jelszó nem egyezik."); process.exit(1); }
const line = `HUD_PASSWORD_HASH=${hashPassword(a)}`;
const env = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
const next = /^HUD_PASSWORD_HASH=.*$/m.test(env) ? env.replace(/^HUD_PASSWORD_HASH=.*$/m, line) : env.replace(/\n?$/, "\n") + line + "\n";
fs.writeFileSync(".env", next, { mode: 0o600 });
console.log("✅ A jelszó lenyomata elmentve a .env-be (HUD_PASSWORD_HASH). Indítsd újra a botot.");
