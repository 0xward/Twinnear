/**
 * 1Click / NEAR Intents settlement — LIVE implementation.
 *
 * Talks to the real 1Click REST API (https://1click.chaindefuser.com/v0),
 * no API key / JWT needed for quotes and status. No keys are ever handled
 * here — the client only ever sends tokens to a 1Click deposit address
 * from their own origin-chain wallet.
 *
 * VERIFIED LIVE 2026-11-06 (probed with curl, no funds moved):
 * - GET /v0/tokens returns 216 assets, incl. USDC on Base
 *   (nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near),
 *   ETH (nep141:eth.omft.near), wNEAR (nep141:wrap.near), USDC on NEAR
 *   (nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1).
 * - Dry quote 10 USDC (Base) -> 9.99436 USDC (NEAR), ~35 s.
 * - Dry quote 0.05 ETH -> 29.615 wNEAR, ~45 s.
 * - Live quote EXACT_OUTPUT 1 wNEAR <- 0.0017036 ETH returned deposit
 *   address 0x67BccC623Fd586FA3fE6D4D2aBcA6ab0bEd1C8de; GET /v0/status for
 *   it returned PENDING_DEPOSIT.
 *
 * MAINNET ONLY — there is NO testnet for NEAR Intents
 * (docs.near-intents.org: "There is no testnet version of NEAR Intents").
 * A `.testnet` recipient is rejected by the API (HTTP 500 on quote).
 * On testnet, invoices settle in NEAR directly through the contract;
 * this module is the live mainnet settlement path, and the UI must say so.
 * `assertMainnetRecipient` enforces that with a clear error instead of
 * letting the API fail opaquely.
 *
 * How settlement closes an invoice: 1Click delivers wNEAR/USDC straight
 * to the seller's NEAR account (no escrow). The seller then closes the
 * invoice on-chain with the contract's `confirm_external_payment`,
 * recording the 1Click deposit address as the reference.
 *
 * Docs: https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote
 */

const ONE_CLICK_BASE = "https://1click.chaindefuser.com/v0";

/** wNEAR on NEAR — 24 decimals, same base units as NEAR. */
export const WNEAR_ASSET = "nep141:wrap.near";

/** USDC on NEAR (nep141) — 6 decimals, base unit is micro-USDC.
 *  Destination asset for USDC invoices: 1Click delivers exactly the
 *  invoice amount (in micro-USDC) straight to the seller. */
export const USDC_NEAR_ASSET =
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export interface IntentToken {
  assetId: string;
  symbol: string;
  decimals: number;
  blockchain: string;
}

/** Curated source assets a client can pay from (verified in /v0/tokens). */
export const SOURCE_ASSETS: Array<IntentToken & { label: string }> = [
  {
    label: "USDC on Base",
    assetId:
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    symbol: "USDC",
    decimals: 6,
    blockchain: "base",
  },
  {
    label: "USDC on Ethereum",
    assetId:
      "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    symbol: "USDC",
    decimals: 6,
    blockchain: "eth",
  },
  {
    label: "ETH on Ethereum",
    assetId: "nep141:eth.omft.near",
    symbol: "ETH",
    decimals: 18,
    blockchain: "eth",
  },
  {
    label: "USDC on Arbitrum",
    assetId:
      "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    symbol: "USDC",
    decimals: 6,
    blockchain: "arb",
  },
];

export const MAINNET_ONLY_NOTE =
  "1Click / NEAR Intents has no testnet (verified 2026-11-06). Quotes below " +
  "are live mainnet prices. A .testnet recipient is rejected by the 1Click " +
  "API, so on testnet invoices settle in NEAR directly through the contract; " +
  "cross-chain settlement runs on mainnet, where the seller receives wNEAR " +
  "and confirms it on-chain with confirm_external_payment.";

export function assertMainnetRecipient(recipient: string): void {
  if (recipient.endsWith(".testnet")) {
    throw new Error(
      "1Click is mainnet-only: recipient " +
        recipient +
        " is a testnet account, which the 1Click API rejects " +
        "(verified 2026-11-06: quotes to .testnet recipients fail). " +
        "Use a mainnet account to get a live quote.",
    );
  }
}

export interface IntentQuote {
  /** Exact input the client must deposit (base units of the source token). */
  amountIn: string;
  amountInFormatted: string;
  /** Exact output the seller receives (base units of the destination token). */
  amountOut: string;
  amountOutFormatted: string;
  /** Estimated time to finality, in seconds. */
  timeEstimateSec: number;
  /** Deposit address on the origin chain (live quotes only, dry=false). */
  depositAddress: string | null;
  deadline: string | null;
  signature: string;
  correlationId: string;
}

export interface SwapStatus {
  /** e.g. PENDING_DEPOSIT, PROCESSING, SUCCESS, FAILED, REFUNDED. */
  status: string;
  depositedAmountFormatted: string | null;
  amountOutFormatted: string | null;
  updatedAt: string | null;
}

async function oneClick<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ONE_CLICK_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body: Record<string, unknown> = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      typeof body.message === "string" ? body.message : JSON.stringify(body);
    throw new Error(`1Click ${path} failed (HTTP ${res.status}): ${msg}`);
  }
  return body as T;
}

interface QuoteApiResponse {
  quote: {
    amountIn: string;
    amountInFormatted: string;
    amountOut: string;
    amountOutFormatted: string;
    timeEstimate: number;
    depositAddress?: string;
    deadline?: string;
  };
  signature: string;
  correlationId: string;
}

export interface QuoteIntentParams {
  /** Source asset id, e.g. one of SOURCE_ASSETS. */
  sourceAsset: string;
  /** Exact output the seller must receive, in destination base units
   *  (for wNEAR: yoctoNEAR, same as the invoice amount). */
  amountOutBaseUnits: string;
  /** Destination asset id — WNEAR for NEAR invoices (amount in
   *  yoctoNEAR), USDC_NEAR_ASSET for USDC invoices (amount in
   *  micro-USDC). */
  destinationAsset?: string;
  /** Seller's NEAR account (mainnet only — see assertMainnetRecipient). */
  recipient: string;
  /** Refund address on the ORIGIN chain (the client's EVM address). */
  refundTo: string;
  /** Slippage tolerance in basis points (100 = 1%). */
  slippageTolerance?: number;
  /** dry=true: price preview only, no deposit address. */
  dry?: boolean;
}

/**
 * Request a 1Click quote that delivers EXACTLY `amountOutBaseUnits` to the
 * seller. With dry=false the response includes the deposit address the
 * client must send `amountIn` to from their origin-chain wallet.
 */
export async function quoteIntentSettlement(
  params: QuoteIntentParams,
): Promise<IntentQuote> {
  assertMainnetRecipient(params.recipient);
  const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const res = await oneClick<QuoteApiResponse>("/quote", {
    method: "POST",
    body: JSON.stringify({
      dry: params.dry ?? false,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: params.slippageTolerance ?? 100,
      originAsset: params.sourceAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: params.destinationAsset ?? WNEAR_ASSET,
      amount: params.amountOutBaseUnits,
      refundTo: params.refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient: params.recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline,
      quoteWaitingTimeMs: 5000,
    }),
  });
  return {
    amountIn: res.quote.amountIn,
    amountInFormatted: res.quote.amountInFormatted,
    amountOut: res.quote.amountOut,
    amountOutFormatted: res.quote.amountOutFormatted,
    timeEstimateSec: res.quote.timeEstimate,
    depositAddress: res.quote.depositAddress ?? null,
    deadline: res.quote.deadline ?? null,
    signature: res.signature,
    correlationId: res.correlationId,
  };
}

/** Live execution status for a deposit address. */
export async function getSwapStatus(
  depositAddress: string,
): Promise<SwapStatus> {
  const res = (await oneClick<Record<string, unknown>>(
    `/status?depositAddress=${encodeURIComponent(depositAddress)}`,
  )) as {
    status: string;
    updatedAt?: string;
    swapDetails?: {
      depositedAmountFormatted?: string | null;
      amountOutFormatted?: string | null;
    };
  };
  return {
    status: res.status,
    depositedAmountFormatted:
      res.swapDetails?.depositedAmountFormatted ?? null,
    amountOutFormatted: res.swapDetails?.amountOutFormatted ?? null,
    updatedAt: res.updatedAt ?? null,
  };
}

const TERMINAL_STATUSES = new Set(["SUCCESS", "FAILED", "REFUNDED"]);

/**
 * Poll 1Click status until the swap reaches a terminal state or the
 * attempt budget is exhausted. Calls `onUpdate` on every poll.
 * Throws on timeout — the caller should surface the last known status.
 */
export async function pollSwapStatus(
  depositAddress: string,
  onUpdate: (status: SwapStatus) => void,
  opts: { intervalMs?: number; maxAttempts?: number } = {},
): Promise<SwapStatus> {
  const intervalMs = opts.intervalMs ?? 15_000;
  const maxAttempts = opts.maxAttempts ?? 40; // ~10 minutes by default
  let last: SwapStatus | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    last = await getSwapStatus(depositAddress);
    onUpdate(last);
    if (TERMINAL_STATUSES.has(last.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `1Click swap for ${depositAddress} did not reach a terminal state ` +
      `after ${maxAttempts} polls (last status: ${last?.status ?? "unknown"}). ` +
      "Check the deposit address on the 1Click status endpoint and retry.",
  );
}
