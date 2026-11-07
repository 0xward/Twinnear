# Twinnear — Gasless Freelancer Invoicing on NEAR

[![CI](https://github.com/0xward/Twinnear/actions/workflows/ci.yml/badge.svg)](https://github.com/0xward/Twinnear/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![NEAR](https://img.shields.io/badge/NEAR-testnet-00C08B)](https://testnet.nearblocks.io)
[![Hackathon](https://img.shields.io/badge/NEAR_Hackathon_2026-Real--World_Money-blue)](https://nearhackathon.com)

**Create an invoice, share a payment link, get paid — without the client
needing NEAR or gas.** Twinnear is a NEAR Hackathon submission for the
**Real-World Money** track: invoicing for real freelancers, settled on
NEAR testnet, with escrow, a rule-based spend-guard, and a gasless
meta-transaction path. **No AI anywhere in this project.**

> **Status:** contract implemented and tested (40/40 unit tests), frontend
> built. The contract is **not yet deployed** — see
> [Deploy the contract](#deploy-the-contract) to deploy it to
> `twinnear.testnet`. Until then the app shows a "Contract not deployed
> yet" notice and the contract buttons stay inert.

## Features

- **Invoices with escrow** — a freelancer creates an invoice, the client
  pays the exact amount into escrow, the freelancer releases it on
  delivery or refunds it. Disputes and due dates included.
- **Payment links** — every invoice has a shareable pay link
  (`#/pay/<id>`) with a QR code.
- **Cross-chain settlement (1Click / NEAR Intents)** — a client can pay
  from another chain (e.g. USDC on Base, ETH) via a live 1Click quote;
  the seller closes the invoice with `confirm_external_payment`.
  *Mainnet only — 1Click has no testnet; on testnet invoices settle in
  NEAR directly.*
- **Gasless invoice creation** — the seller signs a NEP-413 message in
  their wallet; a relayer submits it. The contract re-verifies the
  signature on-chain and enforces per-seller nonce replay protection.
- **Rule-based spend-guard (no AI)** — any account can cap what it can
  be charged (max per invoice, daily cap) and who may charge it
  (seller allowlist). Enforced on-chain at invoice creation and at
  payment.
- **Bookkeeper dashboard** — totals (received / in escrow / pending /
  refunded), per-client totals, and **CSV export**.
- **Deploy from the browser** — pick the wasm file, sign one
  transaction in Meteor Wallet, and the contract is live.

## How it works

```text
Freelancer                    Twinnear contract (NEAR)              Client
    │  create_invoice (or gasless via relayer)                        │
    ├──────────────────────────────▶│                                │
    │  pay link #/pay/<id> ────────────────────────────────────────▶ │
    │                               │  pay_invoice (escrow) ◀────────┤
    │  release_invoice / refund ───▶│                                │
    │                               │  escrow → seller / client      │
    │  dashboard + CSV export ◀─────│                                │
```

- **Contract** (`contract/`, Rust, near-sdk 5): invoices, escrow with
  callback-finalised transfers, disputes, spend-guard policies,
  meta-transactions, two-step owner transfer, escrow rescue.
- **Frontend** (`frontend/`, React 18 + Vite 5 + TypeScript): PAPER
  design (paper-white, serif, ledger lines, one ink accent). NEAR
  Wallet Selector with Meteor + OKX. Hash routing, so the static build
  serves anywhere.
- **Relayer** (`relayer-server/`, Node, near-api-js): reference gasless
  relayer — verifies NEP-413 signatures off-chain and submits
  `create_invoice_meta` from a funded account.

## Quickstart — do X, see Y

Prerequisites: **Node 18+** and **Rust + wasm target**
(`rustup target add wasm32-unknown-unknown`).

```bash
# 1. Build the contract (produces contract/twinnear.wasm, optimized)
cd contract
./build-optimized.sh

# 2. Run the frontend
cd ../frontend
npm install
npm run dev        # → http://localhost:5173
```

Then do this, and see this:

| Do | See |
| --- | --- |
| Open the app, connect a testnet wallet (Meteor or OKX) | Your account in the header |
| Create an invoice for `alice.testnet`, amount `0.5`, any description | It appears in Invoices with status **Pending** |
| Open its pay link (`#/pay/<id>`) as the client and pay | Status flips to **Paid · escrow** |
| As the seller, click "Release to me" | Status becomes **Paid · released**, and the Ledger total "Received" increases by 0.5 Ⓝ |
| Click "Export CSV" on the Ledger page | A `twinnear-invoices-YYYY-MM-DD.csv` download with all rows |

> The contract must be deployed to `twinnear.testnet` first (see
> [Deploy the contract](#deploy-the-contract)); until then the app shows
> a "Contract not deployed yet" notice and the buttons that need the
> contract are inert.

## Deploy the contract

Full instructions (browser path + CLI path, exact commands, key
handling, troubleshooting): **[DEPLOY.md](DEPLOY.md)**.

- **Browser (recommended):** run the frontend, connect Meteor as
  `twinnear.testnet`, open the **Deploy** page, pick
  `contract/twinnear.wasm`, click **Deploy + initialize**, then
  **Verify**. One wallet-signed transaction; no private key leaves
  your wallet.
- **CLI:** `near-cli-rs` with `with-init-call` (deploy + init in one
  transaction — never deploy and init separately).

> Storage: the optimized 194 KB wasm locks ~1.9 NEAR of storage stake
> on the account (1 NEAR per 100 KB). Fund the deployer account from
> the testnet faucet first: https://near-faucet.io

## Deploy to Vercel

The frontend is a static Vite SPA (hash routing — no rewrites needed),
so it imports cleanly into Vercel:

| Vercel setting | Value |
| --- | --- |
| Framework preset | **Vite** |
| Root Directory | `frontend` |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Install Command | `npm install` (default) |

Environment variables (all optional):

| Variable | Purpose |
| --- | --- |
| `VITE_RELAYER_URL` | URL of a running relayer server (see `relayer-server/`). Without it, the UI falls back to direct transactions. |

No other env vars are needed — the contract account
(`twinnear.testnet`) and testnet RPC are set in
`frontend/src/lib/config.ts`.

## Contract API

| Method | Type | Notes |
| --- | --- | --- |
| `new(owner)` | init | Sets owner; init only callable by the contract account itself (atomic deploy+init) |
| `create_invoice(client, amount, description, due_days)` | call, payable | Caller = seller; enforces client policy; requires 0.01 NEAR storage deposit; `due_days` 1–90 or null |
| `create_invoice_meta(seller, client, amount, description, nonce, signature, public_key, nep413_nonce, due_days)` | call | Relayer only; gasless invoice creation, nonce replay protection, NEP-413 signature verified on-chain |
| `set_relayer(relayer)` | call | Owner only; set/clear the trusted relayer |
| `propose_owner(new_owner)` / `accept_owner()` | call | Two-step owner transfer |
| `pay_invoice(id)` | call, payable | Caller = client; deposit must equal amount; escrows funds; re-checks client policy + daily cap |
| `release_invoice(id)` | call | Seller only; sends escrow to seller; blocked while disputed; finalised by callback |
| `refund_invoice(id)` | call | Seller only; returns escrow to client; works even while disputed; finalised by callback |
| `claim_refund(id)` | call | Client only, after the due date; escrow back to the client; finalised by callback |
| `cancel_invoice(id)` | call | Seller only, while Pending; no funds move |
| `open_dispute(id, reason)` / `withdraw_dispute(id)` | call | Client only, on a paid unreleased invoice; dispute blocks release |
| `rescue_escrow(id, to)` | call | Owner only, after a recorded failed transfer; last-resort recovery of stuck escrow |
| `confirm_external_payment(id, reference)` | call | Seller only; closes a Pending invoice paid off-chain (1Click), records the reference (0x address 42 chars or tx hash 66 chars); unilateral attestation, not verified |
| `set_policy(max_amount, allowed_sellers, max_total_per_day)` | call | Caller sets their own spend-guard; daily accounting is preserved across edits |
| `get_invoice(id)` / `list_invoices(from, limit)` | view | |
| `get_policy(account_id)` / `get_owner()` / `get_relayer()` / `get_meta_nonce(account_id)` / `get_invoice_count()` / `get_open_invoice_count(account_id)` / `get_total_escrowed()` / `get_pending_owner()` | view | |

Amounts are yoctoNEAR in the contract; the frontend converts NEAR ↔
yocto. No token other than NEAR is accepted in phase 1.

## Project layout

```text
twinnear/
├── contract/            # Rust contract (near-sdk 5)
│   ├── src/lib.rs       # invoices, escrow, spend-guard policy, meta-tx
│   └── build-optimized.sh  # reproducible optimized wasm build
├── relayer-server/      # Reference gasless relayer (Node, near-api-js)
├── frontend/            # React + Vite + TypeScript, PAPER design
│   └── src/
│       ├── lib/near.ts      # Wallet Selector + view/call helpers
│       ├── lib/intents.ts   # LIVE 1Click/Intents client
│       ├── lib/relayer.ts   # LIVE meta-tx client (NEP-413 signing)
│       ├── lib/csv.ts       # bookkeeper CSV export
│       └── pages/           # Dashboard, Invoices, New invoice, Pay link,
│                            # Spend guard, Deploy
├── docs/                # research notes, QA audit, design decisions
├── README.md
├── DEPLOY.md
├── LICENSE (MIT)
└── .gitignore
```

## Libraries & templates used

- Contract: [near-sdk](https://github.com/near/near-sdk-rs) 5.x
  (+ `borsh` 1.x, required directly by the borsh derive macros).
- Frontend: Vite 5 + React 18 + TypeScript, react-router-dom 6.
- Wallet: [@near-wallet-selector](https://github.com/near/wallet-selector)
  (`core`, `modal-ui`, `meteor-wallet`, `okx-wallet` v8) and
  [near-api-js](https://github.com/near/near-api-js) 5.x (view calls).
- No AI libraries, no AI models, no AI API keys. No template code beyond
  the standard Vite React-TS project layout.

## Disclosure

Twinnear is a **port of TwinPayAI** (an agentic-payments project on
Stacks, by the same author, [@0xward](https://github.com/0xward)) to
NEAR. Only the NEAR integration is new and is what is being judged:
the Rust contract, the NEAR Wallet Selector login, and the 1Click /
Intents + relayer design. The payment flow, the vault / policy-engine
concept, and the ledger UI pattern are carried over from TwinPayAI.
TwinPayAI's Groq AI decision engine was **deliberately removed** —
this build is payments only.

## Known limitations (honest notes, not hidden)

- **No automatic refunds.** A NEAR contract cannot wake itself up —
  there is no on-chain cron. If a seller goes silent, the client must
  click "Claim refund" after the due date (or open a dispute). An
  invoice with no deadline has no claim-refund escape at all.
- **External (1Click) confirmations are unverified attestations.** The
  seller closes the invoice by asserting payment arrived; the contract
  cannot check the 1Click swap. The UI labels these "Paid · external
  (unverified)" and they do not count toward the spend-guard daily cap.
- **The spend-guard does not cover external payments** (see above) and
  a policy change can make a previously-created invoice unpayable —
  that is the point of the guard (an emergency brake), not a bug.
- **The relayer is trusted for gasless creation** (it verifies NEP-413
  signatures off-chain; the contract re-verifies them on-chain, so a
  compromised relayer cannot forge a seller's invoice — but it can
  refuse service). Without a relayer, gasless creation is unavailable
  and the direct path is used instead.
- **Relayer Borsh layout verification is pending.** The phase-2 notes
  report the server's NEP-413 Borsh layout as byte-identical to
  near-api-js's serializer, but no verification artifact is in this
  repo — final confirmation against a real Meteor signature is a
  phase-3 item.
- **The browser deploy page is not yet verified** with a live wallet
  click-through (phase-3 item); near-cli-rs in [DEPLOY.md](DEPLOY.md)
  is the fallback.

## License

MIT — see [LICENSE](LICENSE).
