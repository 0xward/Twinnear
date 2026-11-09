# Twinnear relayer server

Reference gasless-relayer server for Twinnear. It verifies a seller's
NEP-413 signature off-chain and submits `create_invoice_meta` to the
contract from a funded relayer account, so the seller never pays gas.

## Run it

```bash
cd relayer-server
npm install

# Fund a relayer account on testnet first (faucet: https://near-faucet.io),
# export its full-access key, then start the server:
export RELAYER_ACCOUNT_ID=relayer.testnet
export RELAYER_PRIVATE_KEY='ed25519:...'
export CONTRACT_ID=twinnear.testnet   # default
export RELAYER_PORT=3001              # default

# Abuse controls (H-04) - strongly recommended before exposing the
# server beyond localhost:
export RELAYER_ALLOWED_SELLERS="alice.testnet,bob.testnet"  # only these sellers
export RELAYER_RATE_LIMIT_PER_HOUR=10                       # per seller, default 10
export RELAYER_CORS_ORIGINS="http://localhost:5173,http://localhost:4173"
# RELAYER_API_KEY is intentionally NOT set in production (see H-04 below):
# the browser client cannot hold a secret. It stays supported for
# server-to-server clients that can send the x-relayer-key header.
npm start
```

Check it is up: `curl http://localhost:3001/health`.

## Production: Vercel serverless functions (same code, no extra hosting)

Production does NOT run this standalone server. The same logic lives
in the shared core `frontend/api/relay/_core.mjs` and runs as Vercel
serverless functions in the same project as the frontend:

- `GET https://twinnear.vercel.app/api/health` - `frontend/api/health.js`
- `POST https://twinnear.vercel.app/api/relay/create-invoice` -
  `frontend/api/relay/create-invoice.js`

Request and response shapes are identical to this server. Files
under `frontend/api/` starting with `_` are not routes. The private
key and other env vars are set in the Vercel dashboard (project
twinnear → Settings → Environment Variables → Production), never in
the repo. This file (`server.mjs`) is only a thin local-dev wrapper
around the same core, so `npm start` here and the Vercel functions
can never drift apart.

## ⚠️ Before exposing publicly (H-04)

By default the server runs **open**: no seller allowlist
(`RELAYER_ALLOWED_SELLERS` unset) and no API key (`RELAYER_API_KEY`
unset). Anyone who can reach it can submit gasless invoices for
themselves, each one spending the relayer account's NEAR on gas -
a public server without these controls will be drained.

The operator **must** set the seller allowlist before exposing the
server beyond localhost:

```bash
export RELAYER_ALLOWED_SELLERS="alice.testnet,bob.testnet"  # only these sellers
```

While the allowlist is unset the server prints a loud
`WARNING: relayer is running OPEN` line on startup. The per-seller
rate limit (`RELAYER_RATE_LIMIT_PER_HOUR`, default 10/hour) and the
allowlist together bound how much one seller can cost the relayer.

### RELAYER_API_KEY stays UNSET in production (decision, 2026-11-07)

The old advice "set both the allowlist and the API key" assumed a
server-to-server client that can keep a secret. Our client is a
browser: the frontend sends only a `Content-Type` header and never
sends `x-relayer-key`, because any key shipped in the frontend bundle
is public by definition - embedding it would publish it, not protect
anything. So in production `RELAYER_API_KEY` is deliberately left
unset, and the protection is layered instead:

1. **Seller allowlist** (`RELAYER_ALLOWED_SELLERS`) - only listed
   sellers can relay at all. Production allowlist is configured via
   the `RELAYER_ALLOWED_SELLERS` env var in the Vercel dashboard
   (not in this repo): it currently holds 3 accounts
   (`/api/health` reports `allowlistSize: 3`, verified 2026-11-09)
   — `twinnear.testnet` and `0xward.testnet` are the two named in
   this repo; the third account is set only via env, so its name is
   not recorded here. If the env allowlist changes, update this
   note and re-check `/api/health`.
2. **NEP-413 signature** - every request must carry a valid signature
   over the exact invoice fields, made with the seller's own key.
3. **Full-access key check** - the signing key must be a full-access
   key of the seller account (checked on-chain).
4. **On-chain verification** - the contract re-verifies the signature
   and the replay nonce, and only accepts meta calls from the relayer
   account set by the owner via `set_relayer`.
5. **Rate limit** - 10 relayed invoices per seller per hour
   (`RELAYER_RATE_LIMIT_PER_HOUR`).

`RELAYER_API_KEY` remains implemented and usable: if it is set, any
client that sends it must present the matching `x-relayer-key`
header. That is only meaningful for a server-to-server caller that
can actually keep the secret. For the browser client it adds nothing,
so production does not set it. The startup log says so explicitly
(`NOTE: RELAYER_API_KEY is unset (intentional ...)`) when the
allowlist is set, and only warns about the missing key when the
allowlist is empty too - that is the actually-open state.

Then point the frontend at it:

```bash
cd ../frontend
VITE_RELAYER_URL=http://localhost:3001 npm run dev
```

The "Create gaslessly" checkbox appears on the New invoice page.

## What it verifies before submitting

1. The signed message exactly matches the submitted fields (canonical
   format - see `frontend/src/lib/relayer.ts`).
2. The public key is a **full-access key** of the seller account
   (checked against the account's on-chain access keys).
3. The NEP-413 ed25519 signature verifies over the Borsh-serialized
   payload.
4. The replay counter is fresh (greater than the last accepted nonce
   on-chain).

The contract additionally verifies the NEP-413 signature ON-CHAIN
(M-01) and only accepts meta calls from this relayer account. The
owner can rotate or disable the relayer with `set_relayer`.

Requests for one seller are serialised (no nonce race), rate-limited
(10/hour per seller by default), and every relay is logged with its
tx hash. Errors are typed: 400 bad input, 401/403 auth, 409 already
created (same nonce - the invoice exists, refresh instead of
retrying), 429 rate-limited, 502 RPC/contract failure, 503 relayer
low on funds. If the relayer is down or rejects a request, the
frontend offers the direct (user-pays-gas) path instead - the relayer
is a single point of failure for gasless creation only (M-07).

## Caveat (corrected 2026-11-07)

The 2026-11-06 claim that the Borsh layout of the NEP-413 payload
(`borshPayload()` in `frontend/api/relay/_core.mjs`) was
byte-identical to near-api-js's own Borsh serializer was WRONG. A
real Meteor Wallet signature failed live verification with
"NEP-413 signature verification failed": the payload was missing the
hardcoded u32 tag 2147484061 (2^31 + 413) and the signature is over
SHA-256 of the serialized payload, not the raw bytes (Wallet
Selector `serializeNep413` / `verifySignature`, per NEP-413). Both
are now included here AND in the contract's `verify_meta_signature`
— the contract DOES depend on this layout, so the relayer and the
contract must stay in sync. Gasless creation has worked end to end
since the fix.
