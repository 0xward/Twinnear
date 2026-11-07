/**
 * Gasless meta-transaction relayer - LIVE client implementation.
 *
 * Flow: the seller signs a NEP-413 message over the invoice payload in
 * their own wallet (Meteor supports signMessage; OKX may not - the error
 * is surfaced, not swallowed). The signed payload is POSTed to the
 * relayer server, which verifies the signature off-chain, checks the
 * nonce, and submits `create_invoice_meta` to the contract from the
 * funded relayer account. The seller never pays gas.
 *
 * Trust model (documented, not hidden): the contract trusts the relayer
 * account (set by the owner via `set_relayer`, rotatable, clearable with
 * `set_relayer(null)`). The relayer verifies the NEP-413 signature
 * off-chain AND the contract re-verifies it on-chain (M-01), so a
 * compromised relayer cannot forge an invoice for a seller whose key
 * it does not hold - see relayer-server/ for the reference server,
 * including how it checks the signer's key against the account's
 * on-chain access keys and reconstructs the Borsh-serialized NEP-413
 * payload. The contract enforces replay protection with a per-seller
 * nonce and only accepts meta calls from the relayer account; the
 * signature and public key are logged on-chain for audit. The server's
 * Borsh layout was verified byte-identical to near-api-js's serializer
 * (2026-11-06); final confirmation against a real Meteor signature is
 * a phase-3 item.
 *
 * The u64 replay counter is part of the SIGNED message, so one signature
 * can only ever create one invoice: replaying the same signed payload
 * reuses the same counter, and the contract rejects it.
 *
 * The relayer is live in production as Vercel serverless functions
 * at https://twinnear.vercel.app/api (same logic as
 * relayer-server/, shared core in frontend/api/relay/_core.mjs).
 * Set VITE_RELAYER_URL to that URL to enable gasless creation; for
 * local development point it at the standalone server instead
 * (e.g. http://localhost:3001 - see relayer-server/README).
 * Until a relayer is configured, `submitMetaTransaction` throws
 * RelayerNotConfiguredError and the UI falls back to a direct
 * (user-pays-gas) create_invoice, which on testnet costs a fraction
 * of a cent.
 *
 * Canonical message format (must match relayer-server/ exactly):
 *   twinnear:create_invoice|<seller>|<client>|<amountYocto>|<description>|<counter>|<nonceBase64>
 */

import { getSelector, getMetaNonce } from "./near";
import { CONTRACT_ID } from "./config";

/** Relayer server base URL, e.g. http://localhost:3001. Unset = no relayer. */
export const RELAYER_URL: string | undefined =
  import.meta.env.VITE_RELAYER_URL as string | undefined;

export function isRelayerConfigured(): boolean {
  return Boolean(RELAYER_URL);
}

export class RelayerNotConfiguredError extends Error {
  constructor() {
    super(
      "No gasless relayer is configured (VITE_RELAYER_URL is unset). " +
        "Run the reference server in relayer-server/ and set " +
        "VITE_RELAYER_URL, or create the invoice directly. On testnet " +
        "the gas is a fraction of a cent.",
    );
    this.name = "RelayerNotConfiguredError";
  }
}

export interface MetaPayload {
  seller: string;
  client: string;
  amountYocto: string;
  description: string;
  /** Replay counter, signed into the message (must be > last on-chain). */
  counter: number;
  /** Base64 of the 32 random NEP-413 nonce bytes. */
  nonce: string;
  nonceBytes: Uint8Array;
  /** Canonical message the wallet signs (NEP-413 `message` field). */
  message: string;
  /** NEP-413 recipient - the contract account. */
  recipient: string;
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function buildMetaPayload(
  seller: string,
  client: string,
  amountYocto: string,
  description: string,
  counter: number,
  nonceBytes?: Uint8Array,
): MetaPayload {
  const nonce = nonceBytes ?? crypto.getRandomValues(new Uint8Array(32));
  const nonceB64 = base64(nonce);
  return {
    seller,
    client,
    amountYocto,
    description,
    counter,
    nonce: nonceB64,
    nonceBytes: nonce,
    message: `twinnear:create_invoice|${seller}|${client}|${amountYocto}|${description}|${counter}|${nonceB64}`,
    recipient: CONTRACT_ID,
  };
}

export interface SignedMetaPayload {
  payload: MetaPayload;
  /** Base64 signature returned by the wallet. */
  signature: string;
  /** Public key string returned by the wallet, e.g. "ed25519:…". */
  publicKey: string;
}

/**
 * Sign the meta payload in the user's wallet (NEP-413). The wallet never
 * exposes the private key - it only returns the signature.
 */
export async function signMetaPayload(
  payload: MetaPayload,
): Promise<SignedMetaPayload> {
  const selector = await getSelector();
  const wallet = await selector.wallet();
  let signed: { signature: string; publicKey: string } | void;
  try {
    signed = await wallet.signMessage({
      message: payload.message,
      // Wallet Selector types this as Buffer; a Uint8Array works at
      // runtime (Buffer extends Uint8Array).
      nonce: payload.nonceBytes as never,
      recipient: payload.recipient,
    });
  } catch (e) {
    throw new Error(
      "Wallet could not sign the meta-transaction message (NEP-413). " +
        "Meteor Wallet supports this; some wallets do not. " +
        `Underlying error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!signed) {
    throw new Error(
      "Wallet did not return a signature for the meta-transaction message. " +
        "This wallet may not support NEP-413 message signing. Try Meteor Wallet.",
    );
  }
  return { payload, signature: signed.signature, publicKey: signed.publicKey };
}

export interface RelayResult {
  txHash: string;
  invoiceId: number;
}

export interface SubmitMetaParams {
  seller: string;
  client: string;
  amountYocto: string;
  description: string;
  /** Payment deadline in days (1–90), or null for no deadline. */
  dueDays: number | null;
}

export class RelayerDuplicateError extends Error {
  constructor() {
    super(
      "The relayer already created this invoice (same replay counter). " +
        "refresh the invoice list instead of submitting again.",
    );
    this.name = "RelayerDuplicateError";
  }
}

/**
 * Create an invoice gaslessly via the relayer server. Returns the
 * invoice id once the relayer's transaction lands. Throws
 * RelayerNotConfiguredError when no relayer is configured.
 */
export async function submitMetaTransaction(
  params: SubmitMetaParams,
): Promise<RelayResult> {
  if (!RELAYER_URL) throw new RelayerNotConfiguredError();
  const seller = params.seller;
  // Fresh replay counter: strictly greater than the last accepted one.
  const lastNonce = await getMetaNonce(seller);
  const counter = lastNonce + 1;
  const payload = buildMetaPayload(
    seller,
    params.client,
    params.amountYocto,
    params.description,
    counter,
  );
  const signed = await signMetaPayload(payload);
  const res = await fetch(`${RELAYER_URL}/relay/create-invoice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      seller: signed.payload.seller,
      client: signed.payload.client,
      amount: signed.payload.amountYocto,
      description: signed.payload.description,
      nonce: String(signed.payload.counter),
      message: signed.payload.message,
      nonceBase64: signed.payload.nonce,
      recipient: signed.payload.recipient,
      signature: signed.signature,
      publicKey: signed.publicKey,
      dueDays: params.dueDays,
    }),
    // M-07: never hang forever when the relayer is down.
    signal: AbortSignal.timeout(15_000),
  });
  const body: Record<string, unknown> = await res.json().catch(() => ({}));
  if (res.status === 409 && body.alreadyCreated === true) {
    throw new RelayerDuplicateError();
  }
  if (!res.ok) {
    throw new Error(
      `Relayer rejected the meta-transaction (HTTP ${res.status}): ` +
        `${typeof body.error === "string" ? body.error : JSON.stringify(body)}`,
    );
  }
  return {
    txHash: String(body.txHash ?? ""),
    invoiceId: Number(body.invoiceId),
  };
}
