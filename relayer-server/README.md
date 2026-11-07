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

# Abuse controls (H-04) — strongly recommended before exposing the
# server beyond localhost:
export RELAYER_ALLOWED_SELLERS="alice.testnet,bob.testnet"  # only these sellers
export RELAYER_API_KEY="a-long-random-secret"               # clients send x-relayer-key
export RELAYER_RATE_LIMIT_PER_HOUR=10                       # per seller, default 10
export RELAYER_CORS_ORIGINS="http://localhost:5173,http://localhost:4173"
npm start
```

Check it is up: `curl http://localhost:3001/health`.

## ⚠️ Before exposing publicly (H-04)

By default the server runs **open**: no seller allowlist
(`RELAYER_ALLOWED_SELLERS` unset) and no API key (`RELAYER_API_KEY`
unset). Anyone who can reach it can submit gasless invoices for
themselves, each one spending the relayer account's NEAR on gas —
a public server without these controls will be drained.

The operator **must** set both before exposing the server beyond
localhost:

```bash
export RELAYER_ALLOWED_SELLERS="alice.testnet,bob.testnet"  # only these sellers
export RELAYER_API_KEY="a-long-random-secret"               # clients send x-relayer-key
```

While either is unset the server prints a loud `WARNING: relayer is
running OPEN` line on startup. The per-seller rate limit
(`RELAYER_RATE_LIMIT_PER_HOUR`, default 10/hour) and the allowlist
together bound how much one seller can cost the relayer.

Then point the frontend at it:

```bash
cd ../frontend
VITE_RELAYER_URL=http://localhost:3001 npm run dev
```

The "Create gaslessly" checkbox appears on the New invoice page.

## What it verifies before submitting

1. The signed message exactly matches the submitted fields (canonical
   format — see `frontend/src/lib/relayer.ts`).
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
created (same nonce — the invoice exists, refresh instead of
retrying), 429 rate-limited, 502 RPC/contract failure, 503 relayer
low on funds. If the relayer is down or rejects a request, the
frontend offers the direct (user-pays-gas) path instead — the relayer
is a single point of failure for gasless creation only (M-07).

## Caveat

The Borsh layout of the NEP-413 payload (`borshPayload()` in
`server.mjs`) was verified 2026-11-06 to be byte-identical to
near-api-js's own Borsh serializer for the NEP-413 schema. Final
confirmation against a real Meteor Wallet signature is still a
phase-3 click-through item; if the wallet signs different bytes, fix
it here — the contract does not depend on it.
