/**
 * Twinnear relayer server (reference implementation, phase 2 + QA fixes).
 *
 * A small HTTP server that makes invoice creation gasless: the seller
 * signs a NEP-413 message in their own wallet; this server verifies the
 * signature off-chain and submits `create_invoice_meta` to the contract
 * from a funded relayer account. The seller never pays gas.
 *
 * Environment:
 *   RELAYER_ACCOUNT_ID        e.g. relayer.testnet (must hold testnet NEAR)
 *   RELAYER_PRIVATE_KEY       ed25519:... private key of that account
 *   CONTRACT_ID               default twinnear.testnet
 *   RPC_URL                   default https://rpc.testnet.near.org
 *   RELAYER_PORT              default 3001
 *   RELAYER_ALLOWED_SELLERS   optional comma list, e.g. "alice.testnet,bob.testnet"
 *                             — when set, ONLY these sellers may relay (H-04)
 *   RELAYER_API_KEY           optional shared secret; when set, clients must
 *                             send header `x-relayer-key: <key>` (H-04)
 *   RELAYER_RATE_LIMIT_PER_HOUR  default 10 relayed invoices per seller (H-04)
 *
 * H-04 CONFIG WARNING: both RELAYER_ALLOWED_SELLERS and RELAYER_API_KEY
 * default to UNSET, which means the server accepts meta-transactions
 * from ANY seller with no key at all. That is fine for a localhost
 * demo, but the server logs a loud WARNING on startup in that state
 * and must NOT be exposed to the public internet until both are set —
 * otherwise anyone can drain the relayer's NEAR by flooding it with
 * gasless invoices for themselves (see relayer-server/README.md).
 *   RELAYER_CORS_ORIGINS      comma list of allowed browser origins;
 *                             default http://localhost:5173,http://localhost:4173
 *                             (H-04: no more `Access-Control-Allow-Origin: *`)
 *   RELAYER_MAX_BODY_BYTES    default 65536 (M-07)
 *
 * Security notes:
 * - The private key lives ONLY here, on the server. It is never sent to
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
 * wallet signs different bytes, fix borshPayload() here — the contract
 * does not depend on it.
 */

import http from "node:http";
import { connect, keyStores, utils } from "near-api-js";

const RELAYER_ACCOUNT_ID = process.env.RELAYER_ACCOUNT_ID;
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;
const CONTRACT_ID = process.env.CONTRACT_ID ?? "twinnear.testnet";
const RPC_URL = process.env.RPC_URL ?? "https://rpc.testnet.near.org";
const PORT = Number(process.env.RELAYER_PORT ?? 3001);
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
const MAX_BODY_BYTES = Number(process.env.RELAYER_MAX_BODY_BYTES ?? 65536);

const GAS_100_TGAS = 100_000_000_000_000n;
const FETCH_TIMEOUT_MS = 15_000;

/** Timestamped server-side audit log (L-11). */
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/** Error carrying the HTTP status the client should see (L-07). */
class HttpError extends Error {
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
 *    callbackUrl: Option<string> } — callbackUrl is None here. */
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
    // forever — reset it so the next request retries.
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
  // N-4: this function only CHECKS — it does NOT record anything.
  // Recording happens in recordRelay() below, after the signature
  // verifies, so a flood of invalid requests can no longer burn
  // the seller's own quota.
}

/** Record one accepted relay against the seller's hourly quota (N-4).
 *  Called only after the signature + nonce checks pass — i.e. only
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

// ---- HTTP server ----

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleRelay(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
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
  if (API_KEY && req.headers["x-relayer-key"] !== API_KEY) {
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

    // (4b) All verification passed — only NOW does this request
    // consume one unit of the seller's hourly quota (N-4).
    recordRelay(seller);

    // (5) The relayer must still be able to pay gas.
    const balance = await getRelayerBalanceYocto();
    if (balance < 200_000_000_000_000_000_000_000n) {
      throw new HttpError(503, "Relayer is low on funds — try the direct (user-pays-gas) path");
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
      // consumed, the invoice WAS created — report that instead of a
      // generic failure so the client does not submit twice.
      const after = await getMetaNonce(seller).catch(() => null);
      if (after !== null && counter <= after) {
        log("relay duplicate-after-error", { seller, nonce });
        return sendJson(res, 409, {
          error: "Invoice was already created (nonce consumed)",
          alreadyCreated: true,
        });
      }
      throw upstream(
        `Relayer transaction failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const status = outcome.status;
    if (!status || typeof status !== "object" || !("SuccessValue" in status)) {
      const after = await getMetaNonce(seller).catch(() => null);
      if (after !== null && counter <= after) {
        return sendJson(res, 409, {
          error: "Invoice was already created (nonce consumed)",
          alreadyCreated: true,
        });
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
    return sendJson(res, 200, {
      txHash: outcome.transaction.hash,
      invoiceId,
    });
  });
}

const server = http.createServer((req, res) => {
  // CORS: only origins on the allowlist (H-04), never `*`.
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Relayer-Key");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "GET" && req.url === "/health") {
    return (async () => {
      let balanceNear = null;
      try {
        if (RELAYER_ACCOUNT_ID && RELAYER_PRIVATE_KEY) {
          const yocto = await getRelayerBalanceYocto();
          balanceNear = (Number(yocto) / 1e24).toFixed(3);
        }
      } catch {
        balanceNear = null;
      }
      return sendJson(res, 200, {
        ok: true,
        relayer: RELAYER_ACCOUNT_ID ?? null,
        contract: CONTRACT_ID,
        configured: Boolean(RELAYER_ACCOUNT_ID && RELAYER_PRIVATE_KEY),
        balanceNear,
        rateLimitPerHour: RATE_LIMIT_PER_HOUR,
        allowlistSize: ALLOWED_SELLERS.length,
      });
    })();
  }
  if (req.method === "POST" && req.url === "/relay/create-invoice") {
    return handleRelay(req, res).catch((e) => {
      if (e instanceof HttpError) {
        log("relay rejected", { status: e.status, error: e.message });
        return sendJson(res, e.status, { error: e.message });
      }
      log("relay error", e instanceof Error ? e.message : String(e));
      return sendJson(res, 500, { error: "Internal relayer error" });
    });
  }
  return sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  log(
    `Twinnear relayer listening on :${PORT} (contract ${CONTRACT_ID}, ` +
      `relayer ${RELAYER_ACCOUNT_ID ?? "NOT CONFIGURED"}, ` +
      `allowlist ${ALLOWED_SELLERS.length > 0 ? ALLOWED_SELLERS.join(",") : "open (set RELAYER_ALLOWED_SELLERS to restrict)"}, ` +
      `rate limit ${RATE_LIMIT_PER_HOUR}/seller/hour)`,
  );
  // H-04 config note: with an empty allowlist and no API key the
  // relayer accepts meta-transactions from ANY seller — fine on
  // localhost for a demo, but it must NEVER be exposed publicly
  // like this: anyone on the internet could drain the relayer's
  // NEAR by flooding it with gasless invoices for themselves.
  const openProblems = [
    ...(ALLOWED_SELLERS.length === 0
      ? ["RELAYER_ALLOWED_SELLERS is not set — allowlist is empty, any seller can relay"]
      : []),
    ...(!API_KEY
      ? ["RELAYER_API_KEY is not set — anyone can call /relay/create-invoice"]
      : []),
  ];
  if (openProblems.length > 0) {
    log(
      "WARNING: relayer is running OPEN — " +
        openProblems.join("; ") +
        ". Set these env vars before exposing this server beyond localhost.",
    );
  }
});
