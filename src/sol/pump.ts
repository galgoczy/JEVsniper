/**
 * Solana / Pump.fun – program-azonosítók és eseménydekódolás.
 * Forrás: Pump.fun hivatalos nyilvános dokumentáció és IDL – github.com/pump-fun/pump-public-docs (commit cb188ce, 2026-09-29):
 * docs/PUMP_PROGRAM_README.md (programcím, Global, bonding curve), idl/pump.json (eseménymezők sorrendje, diszkriminátorok).
 * Az esemény a tranzakció logjában "Program data: <base64>" sorként jelenik meg: 8 bájt diszkriminátor + Borsh-mezők.
 */
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";       // PUMP_PROGRAM_README.md
export const PUMP_GLOBAL = "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf";        // PUMP_PROGRAM_README.md (PDA ["global"])
export const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";    // PUMP_SWAP_README.md
/** Global.initial_real_token_reserves (PUMP_PROGRAM_README.md): a görbe készlete; haladás = 1 − real_token_reserves / ez. */
export const INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;
export const INITIAL_VIRTUAL_SOL = 30_000_000_000n;      // 30 SOL (lamport)
export const INITIAL_VIRTUAL_TOKEN = 1_073_000_000_000_000n;
export const SOL_DEFAULT_WS = "wss://api.mainnet-beta.solana.com"; // solana.com/docs/references/clusters (publikus, korlátozott)
export const SOL_DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

const DISC = {
  CreateEvent: [27, 114, 169, 77, 222, 235, 99, 118],
  TradeEvent: [189, 219, 127, 211, 78, 230, 97, 238],
  CompleteEvent: [95, 114, 97, 156, 212, 46, 152, 8],
  CompletePumpAmmMigrationEvent: [189, 233, 93, 185, 92, 148, 234, 148],
} as const;
const discKey = (b: Uint8Array) => Array.from(b.subarray(0, 8)).join(",");
const DISC_BY_KEY = new Map(Object.entries(DISC).map(([k, v]) => [v.join(","), k as keyof typeof DISC]));

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(buf: Uint8Array): string {
  let n = 0n; for (const x of buf) n = n * 256n + BigInt(x);
  let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of buf) { if (x === 0) s = "1" + s; else break; }
  return s;
}

export class Reader {
  o = 8; // a diszkriminátor után
  constructor(private b: Buffer) {}
  u8() { return this.b[this.o++]!; }
  bool() { return this.u8() === 1; }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  i64() { const v = this.b.readBigInt64LE(this.o); this.o += 8; return v; }
  pk() { const s = base58(this.b.subarray(this.o, this.o + 32)); this.o += 32; return s; }
  str() { const n = this.b.readUInt32LE(this.o); this.o += 4; const s = this.b.subarray(this.o, this.o + n).toString("utf8"); this.o += n; return s; }
}

export type PumpEvent =
  | { kind: "create"; name: string; symbol: string; uri: string; mint: string; bondingCurve: string; user: string; creator: string; timestamp: number; virtualTokenReserves: bigint; virtualSolReserves: bigint; realTokenReserves: bigint; tokenTotalSupply: bigint; tokenProgram: string; isMayhemMode: boolean; isCashbackEnabled: boolean; quoteMint: string; virtualQuoteReserves: bigint; creatorFeeBps: bigint; isHolderReward: boolean }
  | { kind: "trade"; mint: string; solAmount: bigint; tokenAmount: bigint; isBuy: boolean; user: string; timestamp: number; virtualSolReserves: bigint; virtualTokenReserves: bigint; realSolReserves: bigint; realTokenReserves: bigint; feeRecipient: string; feeBasisPoints: bigint; fee: bigint; creator: string; creatorFeeBasisPoints: bigint; creatorFee: bigint }
  | { kind: "complete"; user: string; mint: string; bondingCurve: string; timestamp: number; quoteMint: string }
  | { kind: "migrate"; user: string; mint: string; mintAmount: bigint; solAmount: bigint; poolMigrationFee: bigint; bondingCurve: string; timestamp: number; pool: string; quoteMint: string };

/** Egy "Program data:" sor base64 tartalmának dekódolása; null, ha nem a 4 figyelt esemény egyike. */
export function decodePumpEvent(base64: string): PumpEvent | null {
  const b = Buffer.from(base64, "base64");
  if (b.length < 8) return null;
  const kind = DISC_BY_KEY.get(discKey(b));
  if (!kind) return null;
  const r = new Reader(b);
  switch (kind) {
    case "CreateEvent": {
      const name = r.str(), symbol = r.str(), uri = r.str(), mint = r.pk(), bondingCurve = r.pk(), user = r.pk(), creator = r.pk(), timestamp = Number(r.i64());
      const virtualTokenReserves = r.u64(), virtualSolReserves = r.u64(), realTokenReserves = r.u64(), tokenTotalSupply = r.u64(), tokenProgram = r.pk();
      const isMayhemMode = r.bool(), isCashbackEnabled = r.bool(), quoteMint = r.pk(), virtualQuoteReserves = r.u64(), creatorFeeBps = r.u64(), isHolderReward = r.bool();
      return { kind: "create", name, symbol, uri, mint, bondingCurve, user, creator, timestamp, virtualTokenReserves, virtualSolReserves, realTokenReserves, tokenTotalSupply, tokenProgram, isMayhemMode, isCashbackEnabled, quoteMint, virtualQuoteReserves, creatorFeeBps, isHolderReward };
    }
    case "TradeEvent": {
      const mint = r.pk(), solAmount = r.u64(), tokenAmount = r.u64(), isBuy = r.bool(), user = r.pk(), timestamp = Number(r.i64());
      const virtualSolReserves = r.u64(), virtualTokenReserves = r.u64(), realSolReserves = r.u64(), realTokenReserves = r.u64();
      const feeRecipient = r.pk(), feeBasisPoints = r.u64(), fee = r.u64(), creator = r.pk(), creatorFeeBasisPoints = r.u64(), creatorFee = r.u64();
      return { kind: "trade", mint, solAmount, tokenAmount, isBuy, user, timestamp, virtualSolReserves, virtualTokenReserves, realSolReserves, realTokenReserves, feeRecipient, feeBasisPoints, fee, creator, creatorFeeBasisPoints, creatorFee };
    }
    case "CompleteEvent": {
      const user = r.pk(), mint = r.pk(), bondingCurve = r.pk(), timestamp = Number(r.i64()), quoteMint = r.pk();
      return { kind: "complete", user, mint, bondingCurve, timestamp, quoteMint };
    }
    case "CompletePumpAmmMigrationEvent": {
      const user = r.pk(), mint = r.pk(), mintAmount = r.u64(), solAmount = r.u64(), poolMigrationFee = r.u64(), bondingCurve = r.pk(), timestamp = Number(r.i64()), pool = r.pk(), quoteMint = r.pk();
      return { kind: "migrate", user, mint, mintAmount, solAmount, poolMigrationFee, bondingCurve, timestamp, pool, quoteMint };
    }
  }
}

/** A logsSubscribe értesítés logsorai → dekódolt események. */
export function eventsFromLogs(logs: string[]): PumpEvent[] {
  const out: PumpEvent[] = [];
  for (const l of logs) if (l.startsWith("Program data: ")) { const e = decodePumpEvent(l.slice(14)); if (e) out.push(e); }
  return out;
}

/** Görbe-ár: SOL / token (a token 6, a SOL 9 tizedes). */
export const curvePrice = (vsol: bigint, vtok: bigint): number => (vtok > 0n ? (Number(vsol) / 1e9) / (Number(vtok) / 1e6) : 0);
/** Görbe-haladás %: elfogyott valódi készlet / kezdeti készlet. */
export const curveProgressPct = (realTok: bigint): number => Math.max(0, Math.min(100, Number(((INITIAL_REAL_TOKEN_RESERVES - realTok) * 10000n) / INITIAL_REAL_TOKEN_RESERVES) / 100));
export const SOL_ZERO_PUBKEY = "11111111111111111111111111111111";
