import "dotenv/config";
import { z } from "zod";

// A privát kulcs és a tokenek soha nem kerülnek logba/riportba. Ez a modul csak
// beolvassa és validálja őket; a Secrets objektumot nem szabad stringgé alakítani.
const EnvSchema = z.object({
  TYPESAFE_API_KEY: z.string().min(10, "TYPESAFE_API_KEY hiányzik"),
  // egy vagy több URL vesszővel elválasztva (tartalék végpontok)
  BASE_RPC_URL: z.string().regex(/^https?:\/\/\S+(\s*,\s*https?:\/\/\S+)*$/, "BASE_RPC_URL: egy vagy több https URL vesszővel"),
  ROBINHOOD_RPC_URL: z.string().regex(/^https?:\/\/\S+(\s*,\s*https?:\/\/\S+)*$/, "ROBINHOOD_RPC_URL: egy vagy több https URL vesszővel"),
  BASE_PRIVATE_TX_RPC_URL: z.string().url().optional().or(z.literal("")),
  ROBINHOOD_PRIVATE_TX_RPC_URL: z.string().url().optional().or(z.literal("")),
  WALLET_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "WALLET_PRIVATE_KEY hiányzik vagy nem 0x + 64 hex"),
  TELEGRAM_BOT_TOKEN: z.string().min(10, "TELEGRAM_BOT_TOKEN hiányzik"),
  TELEGRAM_CHAT_ID: z.string().min(1, "TELEGRAM_CHAT_ID hiányzik"),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(opts: { requireWallet?: boolean } = {}): Env {
  const schema = opts.requireWallet === false
    ? EnvSchema.extend({ WALLET_PRIVATE_KEY: z.string().default("0x" + "0".repeat(64)) })
    : EnvSchema;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Csak a mező nevét írjuk ki, értéket soha.
    const missing = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Hiányzó/hibás .env beállítás: ${missing}`);
  }
  const env = parsed.data;
  // Védelem véletlen kiírás ellen (JSON.stringify, console.log).
  Object.defineProperty(env, "toJSON", { value: () => "[env: rejtett]", enumerable: false });
  Object.defineProperty(env, Symbol.for("nodejs.util.inspect.custom"), { value: () => "[env: rejtett]", enumerable: false });
  return env;
}

/** A logokban a kulcs-szerű stringeket kitakarja. */
export function redact(text: string): string {
  return text
    .replace(/0x[0-9a-fA-F]{64}/g, "0x[REDACTED_KEY]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, "[REDACTED_TG_TOKEN]")
    .replace(/\b(ts|sk|tsk)[-_][A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]");
}
