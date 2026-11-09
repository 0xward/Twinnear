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
 * Trust model (documented, not hidden): the relayer is fully trusted
 * for invoice creation. The contract trusts the relayer account (set
 * by the owner via `set_relayer`, rotatable, clearable with
 * `set_relayer(null)`), and only it may submit `create_invoice_meta`.
 * The relayer verifies the NEP-413 signature off-chain AND the
 * contract re-verifies it on-chain (M-01) — but that check only
 * proves the signature is valid and the nonce is fresh. It does NOT
 * prove the signing key belongs to the seller, so a compromised
 * relayer could forge an invoice in a seller's name. The contract
 * enforces replay protection with a per-seller nonce and only accepts
 * meta calls from the relayer account; the signature and public key
 * are logged on-chain for audit. See relayer-server/ for the
 * reference server and how it verifies the signature and
 * reconstructs the Borsh-serialized NEP-413 payload.
 * CORRECTED 2026-11-07: the claim that the Borsh layout was
 * "verified byte-identical to near-api-js's serializer" was WRONG -
 * a real Meteor signature failed verification live. The payload was
 * missing the hardcoded u32 tag 2147484061 (2^31 + 413) and the
 * signature is over SHA-256 of the serialized payload, not the raw
 * bytes. Both are now included in the server
 * (frontend/api/relay/_core.mjs) and the contract
 * (verify_meta_signature) - the two must stay in sync.
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
 *   twinnear:create_invoice|<seller>|<client>|<amountYocto>|<description>|<counter>|<nonceBase64>|<milestonesJson>|<splitsJson>
 * v5: the two trailing fields are the compact JSON of the milestones
 * and splits arrays (amounts as strings, e.g.
 * `[{"description":"Design","amount":"500"}]`, `[]` when empty) — the
 * contract verifies them on-chain, so a relayer cannot attach a
 * milestone plan or a split the seller never signed for.
 */

import { Buffer } from "buffer";
import { getSelector, getMetaNonce } from "./near";
import { CONTRACT_ID } from "./config";
import { milestonesJson, splitsJson } from "./milestones";
import type { MilestoneInput, SplitShareInput } from "./types";

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
  /** v5: milestones + splits, signed into the message (see buildMetaPayload). */
  milestones: MilestoneInput[];
  splits: SplitShareInput[];
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
  milestones: MilestoneInput[] = [],
  splits: SplitShareInput[] = [],
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
    message: `twinnear:create_invoice|${seller}|${client}|${amountYocto}|${description}|${counter}|${nonceB64}|${milestonesJson(milestones)}|${splitsJson(splits)}`,
    recipient: CONTRACT_ID,
    milestones,
    splits,
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
      // NEP-413 requires a real Buffer of exactly 32 bytes. A plain
      // Uint8Array (from crypto.getRandomValues) is NOT a Buffer:
      // Buffer.isBuffer() returns false for it, and the wallet rejects
      // it with "Invalid nonce. It must be a Buffer with a length of
      // 32 bytes." Buffer.from() copies the same 32 bytes into a real
      // Buffer, so the signed bytes are unchanged.
      nonce: Buffer.from(payload.nonceBytes),
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
  /** v5: funded milestones + splits (NEAR only, signed into the message). */
  milestones?: MilestoneInput[];
  splits?: SplitShareInput[];
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
    undefined,
    params.milestones ?? [],
    params.splits ?? [],
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
      milestones: signed.payload.milestones,
      splits: signed.payload.splits,
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
