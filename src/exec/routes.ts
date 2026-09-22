import { type Address, type Hex, type PublicClient, encodeAbiParameters, encodeFunctionData, parseAbiParameters, isAddressEqual, getAddress } from "viem";
import type { ChainKey } from "../chains/index.js";
import { ADDRESSES, ZERO } from "../chains/addresses.js";
import { ponsCurveAbi, ponsFactoryAbi } from "../abis/pons.js";
import { universalRouterAbi, v4QuoterAbi, permit2Abi, erc20WriteAbi, UR_COMMAND_V4_SWAP, UR_COMMAND_SWEEP,
  V4_ACTION_SWAP_EXACT_IN_SINGLE, V4_ACTION_SETTLE_ALL, V4_ACTION_TAKE_ALL } from "../abis/uniswapV4.js";

export interface PoolKey { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
export interface TxRequest { to: Address; data: Hex; value: bigint; label: string }
export interface Quote { amountOut: bigint; feeWei: bigint; taxWei: bigint; note?: string }

/** Egy vételi/eladási útvonal: árajánlat + tranzakció(k) összeállítása. A küldés az Executor dolga. */
export interface Route {
  readonly kind: "pons_curve" | "uniswap_v4";
  readonly spender: Address;                 // kinek kell approve eladáshoz
  quoteBuy(nativeIn: bigint, wallet: Address): Promise<Quote>;
  quoteSell(tokensIn: bigint): Promise<Quote>;
  buildBuy(nativeIn: bigint, minOut: bigint, recipient: Address, deadlineSec: number): TxRequest;
  /** Eladás: approve tx-ek (csak a szükséges mennyiségre, csak ennek a spendernek) + swap tx. */
  buildSell(tokensIn: bigint, minOut: bigint, recipient: Address, deadlineSec: number, owner: Address): Promise<TxRequest[]>;
}

// ---------- PONS v2 bonding curve (pons-sdk quoteNativeCurveBuy/Sell képletei) ----------
export interface CurveState { quoteReserve: bigint; tokenReserve: bigint; reservedTokens: bigint; feeBps: bigint; creatorTaxBps: bigint; snipeBps: bigint }

export function curveBuyQuote(s: CurveState, quoteIn: bigint): Quote {
  if (quoteIn <= 0n || s.quoteReserve <= 0n || s.tokenReserve <= 0n || s.reservedTokens >= s.tokenReserve || s.feeBps + s.creatorTaxBps >= 10000n) throw new Error("curve: nem árazható vétel");
  let snipe = s.snipeBps;
  const ceiling = 9900n - s.feeBps - s.creatorTaxBps;
  if (snipe > ceiling) snipe = ceiling;
  const fee = (quoteIn * s.feeBps) / 10000n, tax = (quoteIn * s.creatorTaxBps) / 10000n, sn = (quoteIn * snipe) / 10000n;
  const net = quoteIn - fee - tax - sn;
  if (net <= 0n) throw new Error("curve: nettó bemenet ≤ 0");
  const scaled = net * 10000n;
  let out = (scaled * s.tokenReserve) / (s.quoteReserve * 10000n + scaled);
  const sellable = s.tokenReserve - s.reservedTokens;
  if (out > sellable) out = sellable; // a curve végén a maradék
  if (out <= 0n) throw new Error("curve: nincs kimenet");
  return { amountOut: out, feeWei: fee, taxWei: tax + sn, note: sn > 0n ? `snipe-adó ${snipe} bps` : undefined };
}

export function curveSellQuote(s: CurveState, tokensIn: bigint): Quote {
  if (tokensIn <= 0n || s.quoteReserve <= 0n || s.tokenReserve <= 0n || s.feeBps + s.creatorTaxBps >= 10000n) throw new Error("curve: nem árazható eladás");
  const scaled = tokensIn * 10000n;
  const gross = (scaled * s.quoteReserve) / (s.tokenReserve * 10000n + scaled);
  const fee = (gross * s.feeBps) / 10000n, tax = (gross * s.creatorTaxBps) / 10000n;
  const net = gross - fee - tax;
  if (net <= 0n) throw new Error("curve: nettó kimenet ≤ 0");
  return { amountOut: net, feeWei: fee, taxWei: tax };
}

export class PonsCurveRoute implements Route {
  readonly kind = "pons_curve" as const;
  constructor(private client: PublicClient, private token: Address, public readonly curve: Address) {}
  get spender() { return this.curve; }

  async state(wallet: Address): Promise<CurveState & { graduated: boolean }> {
    const fns = ["quoteReserve", "tokenReserve", "reservedTokens", "feeBps", "creatorTaxBps", "graduated"] as const;
    const mc = await this.client.multicall({ allowFailure: false, contracts: [
      ...fns.map((fn) => ({ address: this.curve, abi: ponsCurveAbi, functionName: fn })),
      { address: this.curve, abi: ponsCurveAbi, functionName: "currentSnipeTaxBps", args: [wallet] },
    ] as never }) as unknown as [bigint, bigint, bigint, bigint, bigint, boolean, bigint];
    return { quoteReserve: mc[0], tokenReserve: mc[1], reservedTokens: mc[2], feeBps: mc[3], creatorTaxBps: mc[4], graduated: mc[5], snipeBps: mc[6] };
  }
  async quoteBuy(nativeIn: bigint, wallet: Address) {
    const s = await this.state(wallet);
    if (s.graduated) throw new Error("curve már graduált – v4 útvonal kell");
    return curveBuyQuote(s, nativeIn);
  }
  async quoteSell(tokensIn: bigint) {
    const s = await this.state(ZERO);
    if (s.graduated) throw new Error("curve már graduált – v4 útvonal kell");
    return curveSellQuote(s, tokensIn);
  }
  buildBuy(nativeIn: bigint, minOut: bigint, recipient: Address): TxRequest {
    return { to: this.curve, value: nativeIn, label: "buy(curve)",
      data: encodeFunctionData({ abi: ponsCurveAbi, functionName: "buy", args: [nativeIn, minOut, recipient] }) };
  }
  async buildSell(tokensIn: bigint, minOut: bigint, recipient: Address, _deadline: number, owner: Address): Promise<TxRequest[]> {
    const txs: TxRequest[] = [];
    const allowance = await this.client.readContract({ address: this.token, abi: erc20WriteAbi, functionName: "allowance", args: [owner, this.curve] });
    if (allowance < tokensIn) {
      const balance = await this.client.readContract({ address: this.token, abi: erc20WriteAbi, functionName: "balanceOf", args: [owner] });
      txs.push({ to: this.token, value: 0n, label: "approve(curve)",
        data: encodeFunctionData({ abi: erc20WriteAbi, functionName: "approve", args: [this.curve, balance > tokensIn ? balance : tokensIn] }) });
    }
    txs.push({ to: this.curve, value: 0n, label: "sell(curve)",
      data: encodeFunctionData({ abi: ponsCurveAbi, functionName: "sell", args: [tokensIn, minOut, recipient] }) });
    return txs;
  }
}

// ---------- Uniswap v4 a Universal Routeren keresztül ----------
export function encodeV4SwapCalldata(opts: { poolKey: PoolKey; zeroForOne: boolean; amountIn: bigint; minOut: bigint; inputCurrency: Address; outputCurrency: Address; recipient: Address; deadline: bigint }): Hex {
  const swap = encodeAbiParameters(
    [{ type: "tuple", components: [
      { type: "tuple", name: "poolKey", components: [
        { type: "address", name: "currency0" }, { type: "address", name: "currency1" }, { type: "uint24", name: "fee" }, { type: "int24", name: "tickSpacing" }, { type: "address", name: "hooks" }] },
      { type: "bool", name: "zeroForOne" }, { type: "uint128", name: "amountIn" }, { type: "uint128", name: "amountOutMinimum" }, { type: "bytes", name: "hookData" }] }],
    [{ poolKey: opts.poolKey, zeroForOne: opts.zeroForOne, amountIn: opts.amountIn, amountOutMinimum: opts.minOut, hookData: "0x" }]);
  // v4-periphery Actions: SETTLE_ALL(currency, maxAmount), TAKE_ALL(currency, minAmount)
  const settle = encodeAbiParameters(parseAbiParameters("address currency, uint256 maxAmount"), [opts.inputCurrency, opts.amountIn]);
  const take = encodeAbiParameters(parseAbiParameters("address currency, uint256 minAmount"), [opts.outputCurrency, opts.minOut]);
  const actions = ("0x" + [V4_ACTION_SWAP_EXACT_IN_SINGLE, V4_ACTION_SETTLE_ALL, V4_ACTION_TAKE_ALL].map((a) => a.toString(16).padStart(2, "0")).join("")) as Hex;
  const v4Input = encodeAbiParameters(parseAbiParameters("bytes actions, bytes[] params"), [actions, [swap, settle, take]]);
  // SWEEP: ami a routernél maradna (pl. natív ETH visszajáró), a címzettnek
  const sweep = encodeAbiParameters(parseAbiParameters("address currency, address recipient, uint256 amountMin"), [opts.outputCurrency, opts.recipient, 0n]);
  const commands = ("0x" + [UR_COMMAND_V4_SWAP, UR_COMMAND_SWEEP].map((c) => c.toString(16).padStart(2, "0")).join("")) as Hex;
  return encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: [commands, [v4Input, sweep], opts.deadline] });
}

export class UniswapV4Route implements Route {
  readonly kind = "uniswap_v4" as const;
  private A;
  constructor(private client: PublicClient, private chain: ChainKey, private token: Address, public readonly poolKey: PoolKey) {
    this.A = ADDRESSES[chain];
    if (!this.A.universalRouter || !this.A.v4Quoter || !this.A.permit2) throw new Error(`nincs v4 router/quoter/permit2 cím: ${chain}`);
  }
  get spender() { return this.A.permit2!; }
  private get tokenIsC0() { return isAddressEqual(this.poolKey.currency0, this.token); }
  private get quoteCurrency(): Address { return this.tokenIsC0 ? this.poolKey.currency1 : this.poolKey.currency0; }

  private async quote(zeroForOne: boolean, amountIn: bigint): Promise<bigint> {
    const { result } = await this.client.simulateContract({ address: this.A.v4Quoter!, abi: v4QuoterAbi, functionName: "quoteExactInputSingle",
      args: [{ poolKey: this.poolKey, zeroForOne, exactAmount: amountIn, hookData: "0x" }] });
    return result[0];
  }
  async quoteBuy(nativeIn: bigint) {
    if (!isAddressEqual(this.quoteCurrency, ZERO)) throw new Error("csak natív ETH-páros v4 pool támogatott");
    const out = await this.quote(!this.tokenIsC0, nativeIn); // ETH→token: ha a token currency1, akkor zeroForOne
    return { amountOut: out, feeWei: (nativeIn * BigInt(this.poolKey.fee & 0x7fffff)) / 1_000_000n, taxWei: 0n };
  }
  async quoteSell(tokensIn: bigint) {
    const out = await this.quote(this.tokenIsC0, tokensIn);
    return { amountOut: out, feeWei: 0n, taxWei: 0n };
  }
  buildBuy(nativeIn: bigint, minOut: bigint, recipient: Address, deadlineSec: number): TxRequest {
    const data = encodeV4SwapCalldata({ poolKey: this.poolKey, zeroForOne: !this.tokenIsC0, amountIn: nativeIn, minOut, inputCurrency: ZERO, outputCurrency: this.token, recipient,
      deadline: BigInt(Math.floor(Date.now() / 1000) + deadlineSec) });
    return { to: this.A.universalRouter!, data, value: nativeIn, label: "buy(v4 UR)" };
  }
  async buildSell(tokensIn: bigint, minOut: bigint, recipient: Address, deadlineSec: number, owner: Address): Promise<TxRequest[]> {
    const txs: TxRequest[] = [];
    const permit2 = this.A.permit2!, router = this.A.universalRouter!;
    const [erc20Allowance, p2, balance] = await Promise.all([
      this.client.readContract({ address: this.token, abi: erc20WriteAbi, functionName: "allowance", args: [owner, permit2] }),
      this.client.readContract({ address: permit2, abi: permit2Abi, functionName: "allowance", args: [owner, this.token, router] }),
      this.client.readContract({ address: this.token, abi: erc20WriteAbi, functionName: "balanceOf", args: [owner] }),
    ]);
    // Approve a teljes tartott mennyiségre (= a szükséges: ennyit fogunk lépcsőkben eladni), 7 napra (moon bag limit),
    // hogy pozíciónként egyszer kelljen, ne eladásonként (2 tx ≈ 0,013 USD megtakarítás eladásonként).
    const approveAmt = balance > tokensIn ? balance : tokensIn;
    if (erc20Allowance < tokensIn) txs.push({ to: this.token, value: 0n, label: "approve(permit2)",
      data: encodeFunctionData({ abi: erc20WriteAbi, functionName: "approve", args: [permit2, approveAmt] }) });
    const now = Math.floor(Date.now() / 1000);
    if (p2[0] < tokensIn || p2[1] < now + 60) txs.push({ to: permit2, value: 0n, label: "permit2.approve(router)",
      data: encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [this.token, router, approveAmt, now + 7 * 24 * 3600] }) });
    const data = encodeV4SwapCalldata({ poolKey: this.poolKey, zeroForOne: this.tokenIsC0, amountIn: tokensIn, minOut, inputCurrency: this.token, outputCurrency: ZERO, recipient,
      deadline: BigInt(now + deadlineSec) });
    txs.push({ to: router, data, value: 0n, label: "sell(v4 UR)" });
    return txs;
  }
}

/** Útvonal-választás a token adataiból (DB sor). PONS: curve amíg nem graduált, utána v4; Clanker/Uniswap v4: PoolKey a DB-ből. */
export async function routeFor(client: PublicClient, chain: ChainKey, t: { address: string; launchpad: string; mechanics: string; pool_address: string | null; pool_key_json?: string | null; graduated_at?: number | null }): Promise<Route> {
  const token = getAddress(t.address);
  const A = ADDRESSES[chain];
  if (t.launchpad === "pons" && t.pool_address && A.ponsV2Factory) {
    const rec = await client.readContract({ address: A.ponsV2Factory, abi: ponsFactoryAbi, functionName: "getLaunchedToken", args: [token] }) as unknown as
      { curve: Address; phase: number; poolFee: number; tickSpacing: number; pairToken: Address };
    if (rec.phase !== 2) return new PonsCurveRoute(client, token, getAddress(t.pool_address));
    const pk: PoolKey = t.pool_key_json ? JSON.parse(t.pool_key_json) : {
      currency0: BigInt(token) < BigInt(ZERO) ? token : ZERO, currency1: BigInt(token) < BigInt(ZERO) ? ZERO : token,
      fee: rec.poolFee, tickSpacing: rec.tickSpacing, hooks: A.ponsV2Hook! };
    return new UniswapV4Route(client, chain, token, pk);
  }
  if ((t.mechanics === "v4" || t.mechanics === "v4_hook") && t.pool_key_json) {
    return new UniswapV4Route(client, chain, token, JSON.parse(t.pool_key_json) as PoolKey);
  }
  throw new Error(`nincs támogatott útvonal (${t.launchpad}/${t.mechanics}, PoolKey ${t.pool_key_json ? "van" : "nincs"}) – v2/v3 a következő lépésben`);
}
