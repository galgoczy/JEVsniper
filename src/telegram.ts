import { log } from "./logger.js";

/**
 * Minimális Telegram Bot API kliens (fetch, külső csomag nélkül).
 * Küldés: sendMessage. Parancsok: getUpdates long polling (/status, /stop, /resume, /panic).
 * A token soha nem kerül logba (a logger kitakarja, itt pedig nem is írjuk ki).
 */
export type TelegramCommand = "status" | "report" | "stop" | "resume" | "panic" | "help";

export class Telegram {
  private base: string;
  private offset = 0;
  private handlers: Array<(cmd: TelegramCommand, raw: string) => Promise<string | void>> = [];
  private stopped = false;

  constructor(token: string, private chatId: string, private pollIntervalMs = 3000) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  async send(text: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) { log.warn("Telegram sendMessage hiba", { status: res.status }); return false; }
      return true;
    } catch (e) {
      log.warn("Telegram sendMessage kivétel", { error: (e as Error).message });
      return false;
    }
  }

  async getMe(): Promise<{ username?: string } | null> {
    try {
      const res = await fetch(`${this.base}/getMe`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const j = (await res.json()) as { result?: { username?: string } };
      return j.result ?? null;
    } catch { return null; }
  }

  onCommand(h: (cmd: TelegramCommand, raw: string) => Promise<string | void>) { this.handlers.push(h); }

  /** Long polling ciklus; csak a beállított chat_id-ból fogad parancsot. */
  async startPolling(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      try {
        const res = await fetch(`${this.base}/getUpdates?offset=${this.offset}&timeout=20&allowed_updates=%5B%22message%22%5D`,
          { signal: AbortSignal.timeout(30_000) });
        if (res.ok) {
          const j = (await res.json()) as { result?: Array<{ update_id: number; message?: { text?: string; chat: { id: number | string } } }> };
          for (const u of j.result ?? []) {
            this.offset = u.update_id + 1;
            const m = u.message;
            if (!m?.text || String(m.chat.id) !== String(this.chatId)) continue;
            const cmd = parseCommand(m.text);
            if (!cmd) continue;
            for (const h of this.handlers) {
              const reply = await h(cmd, m.text);
              if (reply) await this.send(reply);
            }
          }
        }
      } catch (e) {
        log.debug("Telegram polling hiba", { error: (e as Error).message });
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }

  stopPolling() { this.stopped = true; }
}

export function parseCommand(text: string): TelegramCommand | null {
  const m = /^\/(status|report|stop|resume|panic|help)(@\w+)?\b/i.exec(text.trim());
  return m ? (m[1]!.toLowerCase() as TelegramCommand) : null;
}
