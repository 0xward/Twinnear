# Deploying Twinnear to NEAR testnet

Target account: **`twinnear.testnet`** (created in Meteor Wallet, funded
with 4 NEAR from the faucet — 0.2 NEAR is the storage reserve, ~3.8 NEAR
usable).

There are two ways to deploy. **The browser path is recommended** — it
signs in your own wallet and never touches a private key.

## Path A — deploy from the browser (recommended)

1. Build the contract (already done here, but rebuild after any change):
   ```bash
   cd contract
   ./build-optimized.sh
   # → twinnear.wasm (193 KB optimized, sha256 below)
   #    (raw cargo output stays at target/wasm32-unknown-unknown/release/twinnear.wasm)
   ```
2. Run the frontend:
   ```bash
   cd ../frontend
   npm install
   npm run dev   # → http://localhost:5173
   ```
3. Open the app, connect **Meteor Wallet** with the `twinnear.testnet`
   account, go to the **Deploy** page.
4. Pick `contract/twinnear.wasm` (the optimized deploy artifact)
   in the file picker. The page shows its size and SHA-256 — check it
   matches the build below.
5. Click **Deploy + initialize**. One wallet-signed transaction sends
   `DeployContract` + init `new` (owner `twinnear.testnet`).
6. Press **Verify** — the page checks the contract exists and reads the
   owner back with `get_owner`.

Current build (2026-11-07, phase 2 + QA fixes, optimized):
- Size: **194,009 bytes** (raw cargo build 242,681 bytes after `strip`)
- SHA-256: `5c1c22243b9ce154d7f31da2d34185067208d2030647060a2869d1f6c6e09b1b`
- 40/40 unit tests pass (was 12 before the QA-fix contract changes).

> Storage: a 193 KB wasm locks ~1.9 NEAR of storage stake on
> the account (1 NEAR per 100 KB). With 4 NEAR in the account, about
> 2.1 NEAR stays liquid after deploy — keep demo invoices small
> (0.05–0.1 NEAR) and top the account up from the faucet again if it
> runs low: https://near-faucet.io

> Status: the Deploy page is implemented but **not yet verified with a
> live wallet click-through** (phase-3 item). If the browser deploy
> fails, use Path B.

## Path B — deploy from the terminal (near-cli-rs)

Install the CLI once. The reliable path is the official prebuilt
release (compiling from source with `cargo install near-cli-rs` takes
~15 min on this VM and failed twice here — first disk-full in `/tmp`,
then the final link step died):

```bash
# Official prebuilt binary, v0.31.1 (x86_64 Linux), SHA-256 verified
# against the published checksum
curl -sL -o near-cli-rs.tar.gz \
  https://github.com/near/near-cli-rs/releases/download/v0.31.1/near-cli-rs-x86_64-unknown-linux-gnu.tar.gz
curl -sL -o near-cli-rs.tar.gz.sha256 \
  https://github.com/near/near-cli-rs/releases/download/v0.31.1/near-cli-rs-x86_64-unknown-linux-gnu.tar.gz.sha256
sha256sum -c near-cli-rs.tar.gz.sha256
tar xzf near-cli-rs.tar.gz --no-same-owner
cp near-cli-rs-x86_64-unknown-linux-gnu/near ~/.cargo/bin/near
near --version   # → near-cli-rs 0.31.1
```

(Or compile from source: `cargo install near-cli-rs` — set
`TMPDIR` to a roomy directory first, e.g. `export
TMPDIR=$HOME/.tmp-build`, or the build dies on `/tmp` space.)

**Key handling — read this first.** The CLI signs with a key from the
local OS keychain (`sign-with-keychain`). The `twinnear.testnet` key
currently lives only in Meteor Wallet on the user's phone, so before
the CLI can sign you must import it yourself on your own machine:

```bash
# Do this on YOUR OWN machine, with YOUR OWN key. Never send the
# private key or seed phrase to anyone, including this agent.
near account import-account using-private-key \
  --account-id twinnear.testnet \
  --private-key 'ed25519:...' \
  network-config testnet
```

Then deploy — deploy + init in ONE command (H-05). The contract's
`new()` only accepts init from the contract account itself, and
`with-init-call` keeps deploy and init in a single transaction, so
nobody can front-run the owner in between. NEVER deploy with
`without-init-call` followed by a separate init call.

```bash
cd contract
near contract deploy twinnear.testnet \
  use-file twinnear.wasm \
  with-init-call new \
  json-args '{"owner": "twinnear.testnet"}' \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send
```

Verify:

```bash
near contract call-function as-read-only twinnear.testnet get_owner \
  json-args '{}' network-config testnet now
# → "twinnear.testnet"

near contract call-function as-read-only twinnear.testnet get_invoice_count \
  json-args '{}' network-config testnet now
# → 0
```

## After deploy — wire up the relayer (optional, for gasless)

The gasless flow needs a relayer account. Any funded testnet account
works (it can be `twinnear.testnet` itself, or a separate one):

```bash
# 1. Start the reference server (see relayer-server/README.md)
cd relayer-server
npm install
export RELAYER_ACCOUNT_ID=relayer.testnet
export RELAYER_PRIVATE_KEY='ed25519:...'
npm start

# 2. Point the contract at it (owner only, signed by twinnear.testnet)
near contract call-function as-transaction twinnear.testnet set_relayer \
  json-args '{"relayer": "relayer.testnet"}' \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  sign-as twinnear.testnet network-config testnet sign-with-keychain send

# 3. Point the frontend at it
cd ../frontend
VITE_RELAYER_URL=http://localhost:3001 npm run dev
```

To disable the relayer later: `set_relayer` with `{"relayer": null}`.

## Troubleshooting

- **Deploy fails with "insufficient balance"**: the account needs
  ~1.9 NEAR free for code storage. Check the balance on
  https://testnet.nearblocks.io/accounts/twinnear.testnet and top up
  from the faucet.
- **"account does not exist"**: the account was never created, or the
  name is wrong — it must be exactly `twinnear.testnet`.
- **Browser deploy shows a wallet error about DeployContract**: the
  connected wallet may not support the DeployContract action — use
  Path B instead and report the exact error.
- **`cargo install near-cli-rs` fails with "No space left on device"**:
  the install uses a large temp dir. Set `TMPDIR` to a roomy directory
  first (this VM: `export TMPDIR=$HOME/.tmp-build`) and retry.
