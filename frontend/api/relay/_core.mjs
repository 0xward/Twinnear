/**
 * Twinnear relayer core (shared by the standalone server and the
 * Vercel serverless functions).
 *
 * This file holds ALL relayer logic: env config, NEP-413 Borsh
 * helpers, on-chain checks, rate limiting, per-seller mutex, the
 * health endpoint and the /relay/create-invoice handler. It has no
 * HTTP-server dependency of its own: callers pass a plain request
 * object to dispatch() and get back a plain { status, body } result.
 *
 * Callers:
 * - relayer-server/server.mjs (standalone Node http server, local dev)
 * - frontend/api/health.js (Vercel: GET /api/health)
 * - frontend/api/relay/create-invoice.js (Vercel: POST /api/relay/create-invoice)
 *
 * A small HTTP server that makes invoice creation gasless: the seller
 * signs a NEP-413 message in their own wallet; this code verifies the
 * signature off-chain and submits `create_invoice_meta` to the contract
 * from a funded relayer account. The seller never pays gas.
 *
 * Environment (names are identical in every deployment):
 *   RELAYER_ACCOUNT_ID        e.g. relayer.twinnear.testnet (must hold testnet NEAR)
 *   RELAYER_PRIVATE_KEY       ed25519:... private key of that account
 *   CONTRACT_ID               default twinnear.testnet
 *   RPC_URL                   default https://rpc.testnet.fastnear.com
 *   RELAYER_ALLOWED_SELLERS   optional comma list, e.g. "alice.testnet,bob.testnet"
 *                             - when set, ONLY these sellers may relay (H-04)
 *   RELAYER_API_KEY           optional shared secret; when set, clients must
 *                             send header `x-relayer-key: <key>` (H-04).
 *                             INTENTIONALLY UNSET in production: the browser
 *                             client cannot hold a secret (anything shipped
 *                             in the frontend bundle is public), so the
 *                             production protection is the seller allowlist
 *                             plus the NEP-413 signature, the full-access
 *                             key check, on-chain verification and the rate
 *                             limit - see relayer-server/README.md (H-04).
 *   RELAYER_RATE_LIMIT_PER_HOUR  default 10 relayed invoices per seller (H-04)
 *   RELAYER_CORS_ORIGINS      comma list of allowed browser origins;
 *                             default http://localhost:5173,http://localhost:4173
 *                             (H-04: no more `Access-Control-Allow-Origin: *`)
 *   RELAYER_MAX_BODY_BYTES    default 65536 (M-07) - standalone server only
 *
 * Security notes:
 * - The private key lives ONLY on the server. It is never sent to
 *   a browser and never committed. The frontend only ever sends a
 *   signature, never a key.
 * - Before submitting, the server verifies:
 *   (1) the signed message exactly matches the submitted fields
 *       (canonical format, see frontend/src/lib/relayer.ts);
 *   (2) the public key is a FULL-ACCESS key of the seller account
 *       (checked against the account's on-chain access keys);
 *   (3) the NEP-413 ed25519 signature verifies over the Borsh-serialized
 *       payload;
 *   (4) the replay counter is fresh (greater than the last accepted
 *       nonce on-chain).
 * - The contract additionally verifies the NEP-413 signature ON-CHAIN
 *   (M-01) and only accepts meta calls from this relayer account.
 * - Every relay is logged (timestamp, seller, invoice id, tx hash) so
 *   there is a server-side audit trail (L-11).
 *
 * VERIFIED 2026-11-06: borshPayload() output is byte-identical to
 * near-api-js's own Borsh serializer for the NEP-413 schema (checked
 * with utils.serialize.serialize). Final confirmation against a real
 * Meteor Wallet signature is still a phase-3 click-through item; if the
 * wallet signs different bytes, fix borshPayload() here - the contract
 * does not depend on it.
 */

import { connect, keyStores, utils } from "near-api-js";

const RELAYER_ACCOUNT_ID = process.env.RELAYER_ACCOUNT_ID;
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;
const CONTRACT_ID = process.env.CONTRACT_ID ?? "twinnear.testnet";
const RPC_URL = process.env.RPC_URL ?? "https://rpc.testnet.fastnear.com";
const ALLOWED_SELLERS = (process.env.RELAYER_ALLOWED_SELLERS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const API_KEY = process.env.RELAYER_API_KEY ?? "";
const RATE_LIMIT_PER_HOUR = Number(process.env.RELAYER_RATE_LIMIT_PER_HOUR ?? 10);
const CORS_ORIGINS = (process.env.RELAYER_CORS_ORIGINS ??
  "http://localhost:5173,http://localhost:4173,http://127.0.0.1:5173,http://127.0.0.1:4173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const GAS_100_TGAS = 100_000_000_000_000n;
const FETCH_TIMEOUT_MS = 15_000;

/** Timestamped server-side audit log (L-11). */
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/** Error carrying the HTTP status the client should see (L-07). */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const badRequest = (m) => new HttpError(400, m);
const unauthorized = (m) => new HttpError(401, m);
const forbidden = (m) => new HttpError(403, m);
const tooMany = (m) => new HttpError(429, m);
const upstream = (m) => new HttpError(502, m);

// ---- Borsh helpers (NEP-413 payload layout) ----

function borshString(s) {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
}

/** Serialize the NEP-413 payload exactly as near-api-js signs it:
 *  { message: string, nonce: [u8; 32], recipient: string,
 *    callbackUrl: Option<string> } - callbackUrl is None here. */
function borshPayload(message, nonceBase64, recipient) {
  const nonce = Buffer.from(nonceBase64, "base64");
  if (nonce.length !== 32) {
    throw new Error("NEP-413 nonce must be 32 bytes");
  }
  return Buffer.concat([
    borshString(message),
    nonce,
    borshString(recipient),
    Buffer.from([0]), // callbackUrl: None
  ]);
}

function canonicalMessage(seller, client, amount, description, counter, nonceBase64) {
  return `twinnear:create_invoice|${seller}|${client}|${amount}|${description}|${counter}|${nonceBase64}`;
}

// ---- NEAR helpers ----

async function rpcQuery(method, params) {
  let res;
  try {
    res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "twinnear-relayer",
        method,
        params,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw upstream(`RPC request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw upstream("RPC returned a non-JSON response");
  }
  if (body.error) throw upstream(`RPC error: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function getMetaNonce(seller) {
  const res = await rpcQuery("query", {
    request_type: "call_function",
    account_id: CONTRACT_ID,
    method_name: "get_meta_nonce",
    args_base64: Buffer.from(JSON.stringify({ account_id: seller })).toString("base64"),
    finality: "final",
  });
  const text = Buffer.from(res.result).toString();
  return BigInt(JSON.parse(text));
}

async function isFullAccessKey(accountId, publicKeyStr) {
  const res = await rpcQuery("query", {
    request_type: "view_access_key_list",
    account_id: accountId,
    finality: "final",
  });
  return (res.keys ?? []).some(
    (k) =>
      k.public_key === publicKeyStr &&
      k.access_key?.permission === "FullAccess",
  );
}

async function getRelayerBalanceYocto() {
  const res = await rpcQuery("query", {
    request_type: "view_account",
    account_id: RELAYER_ACCOUNT_ID,
    finality: "final",
  });
  return BigInt(res.amount) - BigInt(res.locked);
}

let nearPromise = null;
async function getRelayerAccount() {
  if (!nearPromise) {
    if (!RELAYER_ACCOUNT_ID || !RELAYER_PRIVATE_KEY) {
      throw new HttpError(
        500,
        "Relayer is not configured: set RELAYER_ACCOUNT_ID and RELAYER_PRIVATE_KEY",
      );
    }
    const keyStore = new keyStores.InMemoryKeyStore();
    const keyPair = utils.KeyPair.fromString(RELAYER_PRIVATE_KEY);
    await keyStore.setKey("testnet", RELAYER_ACCOUNT_ID, keyPair);
    // M-04: a failed connect must not poison the cached promise
    // forever - reset it so the next request retries.
    nearPromise = connect({
      networkId: "testnet",
      keyStore,
      nodeUrl: RPC_URL,
      walletUrl: "https://wallet.testnet.near.org",
      helperUrl: "https://helper.testnet.near.org",
    }).catch((e) => {
      nearPromise = null;
      throw e;
    });
  }
  const near = await nearPromise;
  return near.account(RELAYER_ACCOUNT_ID);
}

// ---- Rate limiting + per-seller serialisation (H-04, M-04) ----

/** seller -> timestamps (ms) of accepted relays in the last hour. */
const relayHistory = new Map();

function checkRateLimit(seller) {
  const now = Date.now();
  const windowStart = now - 60 * 60 * 1000;
  const stamps = (relayHistory.get(seller) ?? []).filter((t) => t > windowStart);
  if (stamps.length >= RATE_LIMIT_PER_HOUR) {
    throw tooMany(
      `Rate limit: at most ${RATE_LIMIT_PER_HOUR} gasless invoices per seller per hour`,
    );
  }
  // N-4: this function only CHECKS - it does NOT record anything.
  // Recording happens in recordRelay() below, after the signature
  // verifies, so a flood of invalid requests can no longer burn
  // the seller's own quota.
}

/** Record one accepted relay against the seller's hourly quota (N-4).
 *  Called only after the signature + nonce checks pass - i.e. only
 *  for requests that were actually verified and submitted. */
function recordRelay(seller) {
  const now = Date.now();
  const windowStart = now - 60 * 60 * 1000;
  const stamps = (relayHistory.get(seller) ?? []).filter((t) => t > windowStart);
  stamps.push(now);
  relayHistory.set(seller, stamps);
}

/** Per-seller mutex: concurrent requests for one seller run in order,
 *  so two identical counters cannot both pass the nonce check (M-04). */
const sellerLocks = new Map();
function withSellerLock(seller, fn) {
  const prev = sellerLocks.get(seller) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  sellerLocks.set(
    seller,
    run.catch(() => {}),
  );
  return run;
}

// ---- CORS (H-04) ----

/** CORS response headers for one request origin. Only origins on the
 *  allowlist get `Access-Control-Allow-Origin`, never `*`. The
 *  Allow-Headers value is the same for every origin. */
export function getCorsHeaders(origin) {
  const headers = { "Access-Control-Allow-Headers": "Content-Type, X-Relayer-Key" };
  if (origin && CORS_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

// ---- Handlers (framework-agnostic: return { status, body }) ----

async function handleHealth() {
  let balanceNear = null;
  try {
    if (RELAYER_ACCOUNT_ID && RELAYER_PRIVATE_KEY) {
      const yocto = await getRelayerBalanceYocto();
      balanceNear = (Number(yocto) / 1e24).toFixed(3);
    }
  } catch {
    balanceNear = null;
  }
  return {
    status: 200,
    body: {
      ok: true,
      relayer: RELAYER_ACCOUNT_ID ?? null,
      contract: CONTRACT_ID,
      configured: Boolean(RELAYER_ACCOUNT_ID && RELAYER_PRIVATE_KEY),
      balanceNear,
      rateLimitPerHour: RATE_LIMIT_PER_HOUR,
      allowlistSize: ALLOWED_SELLERS.length,
    },
  };
}

async function handleRelay(headers, rawBody) {
  let body;
  if (typeof rawBody === "string") {
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw badRequest("Invalid JSON body");
    }
  } else if (rawBody && typeof rawBody === "object") {
    body = rawBody; // already parsed (e.g. Vercel req.body)
  } else {
    throw badRequest("Invalid JSON body");
  }
  const {
    seller,
    client,
    amount,
    description,
    nonce,
    message,
    nonceBase64,
    recipient,
    signature,
    publicKey,
    dueDays,
  } = body;

  // (0) Basic field validation (400).
  for (const [name, v] of Object.entries({
    seller,
    client,
    amount,
    description,
    nonce,
    message,
    nonceBase64,
    recipient,
    signature,
    publicKey,
  })) {
    if (typeof v !== "string" || v.length === 0) {
      throw badRequest(`Missing or invalid field: ${name}`);
    }
  }
  if (!/^\d+$/.test(amount)) throw badRequest("amount must be yoctoNEAR digits");
  if (description.length > 500) throw badRequest("description too long");
  if (recipient !== CONTRACT_ID) {
    throw badRequest(`recipient must be ${CONTRACT_ID}`);
  }
  if (!/^\d+$/.test(nonce)) throw badRequest("nonce must be a positive integer");
  const counter = BigInt(nonce);
  if (counter <= 0n) throw badRequest("nonce must be a positive integer");
  if (dueDays !== undefined && dueDays !== null) {
    if (!Number.isInteger(dueDays) || dueDays < 1 || dueDays > 90) {
      throw badRequest("dueDays must be an integer between 1 and 90, or null");
    }
  }

  // (0b) Auth: API key (when configured) + seller allowlist (H-04).
  if (API_KEY && headers["x-relayer-key"] !== API_KEY) {
    throw unauthorized("Missing or invalid x-relayer-key header");
  }
  if (ALLOWED_SELLERS.length > 0 && !ALLOWED_SELLERS.includes(seller)) {
    throw forbidden(`seller ${seller} is not on the relayer allowlist`);
  }

  // Serialise per seller (M-04) so the nonce check below cannot race.
  return withSellerLock(seller, async () => {
    checkRateLimit(seller);

    // (1) The signed message must exactly match the submitted fields.
    const expected = canonicalMessage(
      seller,
      client,
      amount,
      description,
      nonce,
      nonceBase64,
    );
    if (message !== expected) {
      throw badRequest("Signed message does not match the submitted fields");
    }

    // (2) The public key must be a full-access key of the seller.
    if (!(await isFullAccessKey(seller, publicKey))) {
      throw badRequest(`public key ${publicKey} is not a full-access key of ${seller}`);
    }

    // (3) Verify the NEP-413 ed25519 signature over the Borsh payload.
    const payloadBytes = borshPayload(message, nonceBase64, recipient);
    const sigBytes = Buffer.from(signature, "base64");
    const ok = utils.PublicKey.fromString(publicKey).verify(payloadBytes, sigBytes);
    if (!ok) throw badRequest("NEP-413 signature verification failed");

    // (4) Replay counter must be fresh.
    const lastNonce = await getMetaNonce(seller);
    if (counter <= lastNonce) {
      throw new HttpError(409, `nonce ${nonce} already used (last accepted: ${lastNonce})`);
    }

    // (4b) All verification passed - only NOW does this request
    // consume one unit of the seller's hourly quota (N-4).
    recordRelay(seller);

    // (5) The relayer must still be able to pay gas.
    const balance = await getRelayerBalanceYocto();
    if (balance < 200_000_000_000_000_000_000_000n) {
      throw new HttpError(503, "Relayer is low on funds - try the direct (user-pays-gas) path");
    }

    // Submit from the relayer account.
    const account = await getRelayerAccount();
    let outcome;
    try {
      outcome = await account.functionCall({
        contractId: CONTRACT_ID,
        methodName: "create_invoice_meta",
        args: {
          seller,
          client,
          amount,
          description,
          nonce: Number(nonce),
          signature,
          public_key: publicKey,
          nep413_nonce: nonceBase64,
          due_days: dueDays ?? null,
        },
        gas: GAS_100_TGAS,
        attachedDeposit: 0n,
      });
    } catch (e) {
      // M-04: the tx may have landed even though we saw an error
      // (timeout after submit, RPC hiccup). If the nonce is now
      // consumed, the invoice WAS created - report that instead of a
      // generic failure so the client does not submit twice.
      const after = await getMetaNonce(seller).catch(() => null);
      if (after !== null && counter <= after) {
        log("relay duplicate-after-error", { seller, nonce });
        return {
          status: 409,
          body: {
            error: "Invoice was already created (nonce consumed)",
            alreadyCreated: true,
          },
        };
      }
      throw upstream(
        `Relayer transaction failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const status = outcome.status;
    if (!status || typeof status !== "object" || !("SuccessValue" in status)) {
      const after = await getMetaNonce(seller).catch(() => null);
      if (after !== null && counter <= after) {
        return {
          status: 409,
          body: {
            error: "Invoice was already created (nonce consumed)",
            alreadyCreated: true,
          },
        };
      }
      throw upstream(`Relayer transaction failed: ${JSON.stringify(status)}`);
    }
    const invoiceId = Number(
      JSON.parse(Buffer.from(status.SuccessValue, "base64").toString()),
    );
    log("relay ok", {
      seller,
      client,
      nonce,
      invoiceId,
      txHash: outcome.transaction.hash,
    });
    return {
      status: 200,
      body: {
        txHash: outcome.transaction.hash,
        invoiceId,
      },
    };
  });
}

/**
 * Dispatch one request. `req` is a plain object:
 *   { method, path, headers, body }
 * `path` is the URL path without query string ("/health" or
 * "/relay/create-invoice"). `body` is the raw request text (Node
 * server) or the already-parsed JSON object (Vercel req.body).
 * Returns { status, body } where body is a plain JSON object.
 * Never throws for client or upstream errors - those become a
 * { status, body: { error } } result instead.
 */
export async function dispatch(req) {
  const { method, path } = req;
  const headers = req.headers ?? {};
  try {
    if (method === "GET" && path === "/health") {
      return await handleHealth();
    }
    if (method === "POST" && path === "/relay/create-invoice") {
      return await handleRelay(headers, req.body);
    }
    return { status: 404, body: { error: "Not found" } };
  } catch (e) {
    if (e instanceof HttpError) {
      log("relay rejected", { status: e.status, error: e.message });
      return { status: e.status, body: { error: e.message } };
    }
    log("relay error", e instanceof Error ? e.message : String(e));
    return { status: 500, body: { error: "Internal relayer error" } };
  }
}

// ---- Startup diagnostics (standalone server log) ----

/** One-line summary for the server listen log. */
export function getStartupSummary(port) {
  return (
    `Twinnear relayer listening on :${port} (contract ${CONTRACT_ID}, ` +
    `relayer ${RELAYER_ACCOUNT_ID ?? "NOT CONFIGURED"}, ` +
    `allowlist ${ALLOWED_SELLERS.length > 0 ? ALLOWED_SELLERS.join(",") : "open (set RELAYER_ALLOWED_SELLERS to restrict)"}, ` +
    `rate limit ${RATE_LIMIT_PER_HOUR}/seller/hour)`
  );
}

/**
 * Startup warnings. The relayer is OPEN only when the allowlist is
 * empty: then anyone on the internet could drain the relayer's NEAR
 * by flooding it with gasless invoices for themselves. When the
 * allowlist IS set, an unset RELAYER_API_KEY is intentional, not a
 * hole: the browser client cannot hold a secret, and the allowlist
 * plus the NEP-413 signature, the full-access key check, on-chain
 * verification and the rate limit are the production protection.
 */
export function getStartupWarnings() {
  const problems = [];
  if (ALLOWED_SELLERS.length === 0) {
    problems.push("RELAYER_ALLOWED_SELLERS is not set - allowlist is empty, any seller can relay");
    if (!API_KEY) {
      problems.push("RELAYER_API_KEY is not set - anyone can call /relay/create-invoice");
    }
  }
  return problems;
}

/** Informational startup lines (not warnings). */
export function getStartupNotes() {
  const notes = [];
  if (ALLOWED_SELLERS.length > 0 && !API_KEY) {
    notes.push(
      "RELAYER_API_KEY is unset (intentional: the browser client cannot hold a secret; " +
        "protection is the seller allowlist + NEP-413 signature + full-access key check + rate limit).",
    );
  }
  return notes;
}
