import { type Address, type Log, decodeEventLog, isAddressEqual, type AbiEvent, toEventSelector } from "viem";
import type { ChainKey } from "../chains/index.js";
import { ADDRESSES, ZERO } from "../chains/addresses.js";
import { clankerV4TokenCreatedEvent } from "../abis/clankerV4.js";
import { ponsFactoryAbi } from "../abis/pons.js";
import { uniswapV2FactoryAbi, uniswapV3FactoryAbi, uniswapV4PoolManagerAbi } from "../abis/uniswap.js";

export type Mechanics = "bonding_curve" | "v2" | "v3" | "v4" | "v4_hook";

export interface NewToken {
  chain: ChainKey;
  address: Address;
  creator: Address | null;
  launchpad: string;
  mechanics: Mechanics;
  pool: Address | `0x${string}` | null;   // pool cím vagy v4 poolId
  pairToken: Address;                      // ETH esetén 0x0
  name: string | null;
  symbol: string | null;
  blockNumber: bigint;
  txHash: `0x${string}` | null;
  graduationThreshold?: bigint;            // PONS: ennyi quote (wei) után graduál a curve
}

export interface LogSource {
  key: string;
  chain: ChainKey;
  address: Address;
  event: AbiEvent;
  topic0: `0x${string}`;
  decode: (log: Log) => NewToken | null;
}

const ev = (abi: readonly unknown[], name: string) =>
  (abi as AbiEvent[]).find((e) => e.type === "event" && e.name === name)!;

const isQuote = (chain: ChainKey, a: Address) => isAddressEqual(a, ZERO) || isAddressEqual(a, ADDRESSES[chain].weth);

/** Az adott láncon figyelt források (launchpad + Uniswap-indítások). */
export function sourcesFor(chain: ChainKey, enabled: Record<string, boolean>): LogSource[] {
  const A = ADDRESSES[chain];
  const out: Omit<LogSource, "topic0">[] = [];

  if (A.clankerV4Factory && enabled.clanker !== false) {
    out.push({
      key: "clanker", chain, address: A.clankerV4Factory, event: clankerV4TokenCreatedEvent as unknown as AbiEvent,
      decode: (log) => {
        const { args } = decodeEventLog({ abi: [clankerV4TokenCreatedEvent], data: log.data, topics: log.topics });
        return {
          chain, address: args.tokenAddress, creator: args.tokenAdmin, launchpad: "clanker", mechanics: "v4_hook",
          pool: args.poolId, pairToken: args.pairedToken, name: args.tokenName, symbol: args.tokenSymbol,
          blockNumber: log.blockNumber ?? 0n, txHash: log.transactionHash,
        };
      },
    });
  }

  if (A.ponsV2Factory && enabled.pons !== false) {
    out.push({
      key: "pons", chain, address: A.ponsV2Factory, event: ev(ponsFactoryAbi, "TokenLaunched"),
      decode: (log) => {
        const { args } = decodeEventLog({ abi: ponsFactoryAbi, eventName: "TokenLaunched", data: log.data, topics: log.topics });
        return {
          chain, address: args.token, creator: args.deployer, launchpad: "pons", mechanics: "bonding_curve",
          pool: args.curve, pairToken: args.pairToken, name: null, symbol: null,
          blockNumber: log.blockNumber ?? 0n, txHash: log.transactionHash, graduationThreshold: args.graduationThreshold,
        };
      },
    });
  }

  if (A.uniswapV2Factory && enabled.uniswap_v2 !== false) {
    out.push({
      key: "uniswap_v2", chain, address: A.uniswapV2Factory, event: ev(uniswapV2FactoryAbi, "PairCreated"),
      decode: (log) => {
        const { args } = decodeEventLog({ abi: uniswapV2FactoryAbi, data: log.data, topics: log.topics });
        const [t0, t1] = [args.token0, args.token1];
        const token = isQuote(chain, t1) ? t0 : isQuote(chain, t0) ? t1 : null;
        if (!token) return null; // csak ETH/WETH pár érdekes
        return { chain, address: token, creator: null, launchpad: "uniswap", mechanics: "v2", pool: args.pair,
          pairToken: token === t0 ? t1 : t0, name: null, symbol: null, blockNumber: log.blockNumber ?? 0n, txHash: log.transactionHash };
      },
    });
  }

  if (A.uniswapV3Factory && enabled.uniswap_v3 !== false) {
    out.push({
      key: "uniswap_v3", chain, address: A.uniswapV3Factory, event: ev(uniswapV3FactoryAbi, "PoolCreated"),
      decode: (log) => {
        const { args } = decodeEventLog({ abi: uniswapV3FactoryAbi, data: log.data, topics: log.topics });
        const [t0, t1] = [args.token0, args.token1];
        const token = isQuote(chain, t1) ? t0 : isQuote(chain, t0) ? t1 : null;
        if (!token) return null;
        return { chain, address: token, creator: null, launchpad: "uniswap", mechanics: "v3", pool: args.pool,
          pairToken: token === t0 ? t1 : t0, name: null, symbol: null, blockNumber: log.blockNumber ?? 0n, txHash: log.transactionHash };
      },
    });
  }

  if (A.uniswapV4PoolManager && enabled.uniswap_v4 !== false) {
    out.push({
      key: "uniswap_v4", chain, address: A.uniswapV4PoolManager, event: ev(uniswapV4PoolManagerAbi, "Initialize"),
      decode: (log) => {
        const { args } = decodeEventLog({ abi: uniswapV4PoolManagerAbi, data: log.data, topics: log.topics });
        const [c0, c1] = [args.currency0, args.currency1];
        const token = isQuote(chain, c0) ? c1 : isQuote(chain, c1) ? c0 : null;
        if (!token) return null;
        const hooked = !isAddressEqual(args.hooks, ZERO);
        return { chain, address: token, creator: null, launchpad: "uniswap", mechanics: hooked ? "v4_hook" : "v4", pool: args.id,
          pairToken: token === c0 ? c1 : c0, name: null, symbol: null, blockNumber: log.blockNumber ?? 0n, txHash: log.transactionHash };
      },
    });
  }

  return out.map((s) => ({ ...s, topic0: toEventSelector(s.event) }));
}
