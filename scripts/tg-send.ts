/**
 * Egy Telegram-üzenet küldése a bot csatornájára (2026-10-08: kézi/ütemezett kiértékelésekhez).
 * Használat: npm run tg -- "szöveg"   vagy   echo "szöveg" | npm run tg
 */
import { loadEnv } from "../src/env.js";
import { Telegram } from "../src/telegram.js";
import fs from "node:fs";

const env = loadEnv();
const text = process.argv.slice(2).join(" ").trim() || fs.readFileSync(0, "utf8").trim();
if (!text) { console.log("❌ üres üzenet"); process.exit(1); }
const ok = await new Telegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID).send(text);
console.log(ok ? "✅ elküldve" : "❌ küldés sikertelen");
process.exit(ok ? 0 : 1);
