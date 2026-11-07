<p align="center">
  <img src="frontend/public/logo.svg" alt="Twinnear" width="360">
</p>

# Twinnear: Gasless Freelancer Invoicing on NEAR

[![CI](https://github.com/0xward/Twinnear/actions/workflows/ci.yml/badge.svg)](https://github.com/0xward/Twinnear/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![NEAR](https://img.shields.io/badge/NEAR-testnet-00C08B)](https://testnet.nearblocks.io)
[![Hackathon](https://img.shields.io/badge/NEAR_Hackathon_2026-Real--World_Money-blue)](https://nearhackathon.com)

Twinnear is invoicing for freelancers on NEAR testnet. A freelancer
creates an invoice, shares a payment link, and the client pays. The
payment sits in escrow until the freelancer releases it or refunds it.
A client can pay in NEAR, or pay in USDC from another chain through
NEAR Intents (1Click) without holding NEAR.

This is a NEAR Hackathon submission for the **Real-World Money** track.
Testnet only. No AI.

## Live status

- **Contract:** `twinnear.testnet`, schema version 2 (`get_version` returns 2)
- **Wasm SHA-256:** `dbd630d0c3ce6cf2b5afacf2b9d1f6b2be3fe2760f2d6eac2b452be3bb5d49a0`
- **First deployed:** 7 November 2026. **Upgraded to v2:** same day, with
  an owner-only state migration (`migrate`). Invoice #1 survived the
  migration unchanged.
- **Site:** https://twinnear.vercel.app
- **About:** https://twinnear.vercel.app/#/about
- **Guides:** https://twinnear.vercel.app/#/docs
- **Repo:** https://github.com/0xward/Twinnear
- **Tests:** 50 unit tests pass (`cargo test` in `contract/`)

Invoices, retainers, the client portal, PDF export, and the pay flow
(create, pay into escrow, release) all work against the live contract.
They were tested end to end on 7 November 2026.

## Features

- **Invoices with escrow.** A freelancer creates an invoice, the client
  pays the exact amount into escrow, the freelancer releases it on
  delivery or refunds it. Due dates and disputes are included.
- **Payment links.** Every invoice has a shareable pay link
  (`#/pay/<id>`) with a QR code.
- **USDC invoices.** An invoice can be denominated in USDC (6 decimals)
  and settled through 1Click straight to the seller, with no escrow.
  1Click is mainnet only, it has no testnet, so on testnet a USDC
  invoice is closed by the seller with `confirm_external_payment`
  and labelled unverified.
- **Cross-chain settlement (1Click / NEAR Intents).** A client can pay
  from another chain (for example USDC on Base) through a live 1Click
  quote. The seller then closes the invoice with
  `confirm_external_payment`.
- **Line items, tax, and PDF.** An invoice can list line items with a
  tax rate. The contract checks the arithmetic, and the pay page
  exports a PDF invoice.
- **Retainers.** Recurring invoice templates (weekly, monthly,
  quarterly) kept in the browser. One click generates the invoices
  that are due.
- **Client portal.** Clients connect a wallet and see only the
  invoices billed to them, with a Pay button.
- **Fiat estimates.** NEAR and USDC amounts show a rough USD estimate
  next to them (CoinGecko price). It is an estimate, never the
  settlement rate.
- **Gasless invoice creation.** The seller signs a NEP-413 message in
  their wallet and a relayer submits it. The contract checks the
  signature on chain and enforces per-seller nonce replay protection.
  Gasless creation covers single-line NEAR invoices only.
- **Rule-based spend-guard.** Any account can cap what it can be
  charged (max per invoice, daily cap) and who may charge it (seller
  allowlist). The contract enforces this when an invoice is created
  and when it is paid.
- **Bookkeeper dashboard.** Totals for received, in escrow, pending,
  and refunded, per-client totals, and **CSV export**.
- **Deploy from the terminal.** near-cli-rs from a computer or Termux.
  There is no browser deploy: Meteor Wallet refuses the
  DeployContract action.

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
  Wallet Selector with Meteor + OKX (mainnet-only) + Intear. Hash routing, so the static build
  serves anywhere.
- **Relayer** (`relayer-server/`, Node, near-api-js): reference gasless
  relayer. It checks NEP-413 signatures off chain and submits
  `create_invoice_meta` from a funded account.

## Quickstart

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
| Open the app, connect a testnet wallet (Meteor) | Your account in the header |
| Create an invoice for `alice.testnet`, amount `0.5`, any description | It appears in Invoices with status **Pending** |
| Open its pay link (`#/pay/<id>`) as the client and pay | Status changes to **Paid**, funds held in escrow |
| As the seller, click "Release to me" | Status becomes **Paid, released**, and the Ledger total "Received" increases by 0.5 Ⓝ |
| Click "Export CSV" on the Ledger page | A `twinnear-invoices-YYYY-MM-DD.csv` download with all rows |

The live contract is `twinnear.testnet` (schema v2). To redeploy
after a contract change, see
[Deploy the contract](#deploy-the-contract). Redeploy without init,
then run the owner-only `migrate`.

## Deploy the contract

Full instructions (CLI path, exact commands, key handling,
troubleshooting): **[DEPLOY.md](DEPLOY.md)**.

- **CLI (the working path):** `near-cli-rs` with `with-init-call`
  for the first deploy (deploy and init in one transaction; never
  deploy and init separately), and `without-init-call` plus the
  owner-only `migrate` for upgrades. Tested from Termux (proot-distro
  Ubuntu, aarch64 binary) on 2026-11-07.

> Storage: the optimized 213 KB wasm locks about 2.1 NEAR of storage
> stake on the account (1 NEAR per 100 KB). Fund the deployer account
> from the testnet faucet first: https://near-faucet.io

## Deploy to Vercel

The frontend is a static Vite SPA (hash routing, no rewrites needed),
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

No other env vars are needed. The contract account
(`twinnear.testnet`) and testnet RPC are set in
`frontend/src/lib/config.ts`.

## Contract API

| Method | Type | Notes |
| --- | --- | --- |
| `new(owner)` | init | Sets owner. Init is only callable by the contract account itself (atomic deploy and init). |
| `create_invoice(client, amount, description, due_days, currency, items, tax_rate_bps)` | call, payable | Caller is the seller. Enforces the client policy. Requires a 0.01 NEAR storage deposit. `due_days` 1 to 90, or null. `currency` Near or Usdc. Up to 20 line items. Tax 0 to 100%. A single-line invoice must have tax 0 and subtotal equal to amount. |
| `migrate()` | call | Owner only. Upgrades stored invoices to the current schema (v1 to v2). Ran successfully on 2026-11-07. |
| `get_version()` | view | Current schema version (2). |
| `create_invoice_meta(seller, client, amount, description, nonce, signature, public_key, nep413_nonce, due_days)` | call | Relayer only. Gasless invoice creation, nonce replay protection, NEP-413 signature checked on chain. Single-line NEAR invoices only. |
| `set_relayer(relayer)` | call | Owner only. Sets or clears the trusted relayer. |
| `propose_owner(new_owner)` / `accept_owner()` | call | Two-step owner transfer. |
| `pay_invoice(id)` | call, payable | Caller is the client. Deposit must equal the amount. Funds go into escrow. Re-checks the client policy and daily cap. |
| `release_invoice(id)` | call | Seller only. Sends escrow to the seller. Blocked while disputed. Finalised by callback. |
| `refund_invoice(id)` | call | Seller only. Returns escrow to the client. Works even while disputed. Finalised by callback. |
| `claim_refund(id)` | call | Client only, after the due date. Escrow goes back to the client. Finalised by callback. |
| `cancel_invoice(id)` | call | Seller only, while Pending. No funds move. |
| `open_dispute(id, reason)` / `withdraw_dispute(id)` | call | Client only, on a paid unreleased invoice. A dispute blocks release. |
| `rescue_escrow(id, to)` | call | Owner only, after a recorded failed transfer. Last-resort recovery of stuck escrow. |
| `confirm_external_payment(id, reference)` | call | Seller only. Closes a Pending invoice paid off chain (1Click) and records the reference (0x address, 42 chars, or tx hash, 66 chars). This is the seller saying payment arrived, not a check the contract can do. |
| `set_policy(max_amount, allowed_sellers, max_total_per_day)` | call | Caller sets their own spend-guard. Daily accounting is kept across edits. |
| `get_invoice(id)` / `list_invoices(from, limit)` | view | |
| `get_policy(account_id)` / `get_owner()` / `get_relayer()` / `get_meta_nonce(account_id)` / `get_invoice_count()` / `get_open_invoice_count(account_id)` / `get_total_escrowed()` / `get_pending_owner()` | view | |

Amounts are yoctoNEAR in the contract for NEAR invoices. The frontend
converts between NEAR and yocto. Since v2, USDC invoices are also
accepted, denominated in micro-USDC (6 decimals) and settled through
1Click, not escrow.

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
│       ├── lib/intents.ts   # 1Click/Intents client
│       ├── lib/relayer.ts   # meta-tx client (NEP-413 signing)
│       ├── lib/invoicePdf.ts # PDF invoice export (jsPDF)
│       ├── lib/fiat.ts      # USD estimates (CoinGecko)
│       ├── lib/recurring.ts # retainer templates (localStorage)
│       ├── lib/csv.ts       # bookkeeper CSV export
│       └── pages/           # Dashboard, Invoices, New invoice, Pay link,
│                            # Spend guard, Retainers, Client portal
├── docs/                # research notes, QA audit, design decisions
├── README.md
├── DEPLOY.md
├── LICENSE (MIT)
└── .gitignore
```

## Libraries and templates used

- Contract: [near-sdk](https://github.com/near/near-sdk-rs) 5.x
  (plus `borsh` 1.x, required directly by the borsh derive macros).
- Frontend: Vite 5 + React 18 + TypeScript, react-router-dom 6.
- Wallet: [@near-wallet-selector](https://github.com/near/wallet-selector)
  (`core`, `modal-ui`, `meteor-wallet`, `okx-wallet`, `intear-wallet` v9) and
  [near-api-js](https://github.com/near/near-api-js) 5.x (view calls).
- No AI libraries, models, or API keys. The only AI ever involved was
  TwinPayAI's Groq decision engine, which was removed (see Disclosure).

## Disclosure

Twinnear is a **port of TwinPayAI** (an agentic-payments project on
Stacks, by the same author, [@0xward](https://github.com/0xward)) to
NEAR. Only the NEAR integration is new and is what is being judged:
the Rust contract, the NEAR Wallet Selector login, and the 1Click /
Intents plus relayer design. The payment flow, the vault and
policy-engine concept, and the ledger UI pattern are carried over from
TwinPayAI. TwinPayAI used a Groq AI decision engine. It is not in
this build. This build is payments only.

## Known limitations

- **No automatic refunds.** A NEAR contract cannot wake itself up.
  There is no on-chain cron. If a seller goes silent, the client must
  click "Claim refund" after the due date (or open a dispute). An
  invoice with no deadline has no claim-refund escape at all.
- **External (1Click) confirmations are unverified attestations.** The
  seller closes the invoice by saying payment arrived. The contract
  cannot check the 1Click swap. The UI labels these "Paid, external
  (unverified)" and they do not count toward the spend-guard daily cap.
- **The spend-guard does not cover external payments** (see above).
  A policy change can also make a previously created invoice
  unpayable. That is the point of the guard (an emergency brake),
  not a bug.
- **The relayer is trusted for gasless creation.** It checks NEP-413
  signatures off chain. The contract checks them on chain too, so a
  compromised relayer cannot forge a seller's invoice, but it can
  refuse service. Without a relayer, gasless creation is unavailable
  and the direct path is used instead.
- **Relayer Borsh layout verification is pending.** The phase-2 notes
  report the server's NEP-413 Borsh layout as byte-identical to
  near-api-js's serializer, but no verification artifact is in this
  repo. Final confirmation against a real Meteor signature is still
  open.
- **Intear wallet is installed but unverified end to end.** The
  Intear module is registered in the wallet modal, but its connect
  flow has not been tested with a real Intear account. Meteor remains
  the verified login path.
- **OKX Wallet is mainnet-only.** The OKX module is registered in the
  wallet modal, but OKX only supports NEAR Mainnet, so it cannot
  connect on testnet.
- **There is no browser deploy.** Meteor Wallet refuses the
  DeployContract action, so deploys go through near-cli-rs (see
  [DEPLOY.md](DEPLOY.md)), tested from Termux on 2026-11-07.

## License

MIT. See [LICENSE](LICENSE).
