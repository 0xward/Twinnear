# Deploying Twinnear to NEAR testnet

Target account: **`twinnear.testnet`** (created in Meteor Wallet, funded
with 4 NEAR from the faucet — 0.2 NEAR is the storage reserve, ~3.8 NEAR
usable).

Contract status: **v2 LIVE** since 2026-11-07 (deployed via Termux +
near-cli-rs, wasm 213,007 bytes, SHA-256
`dbd630d0c3ce6cf2b5afacf2b9d1f6b2be3fe2760f2d6eac2b452be3bb5d49a0`).
The v2 upgrade was a **redeploy + migrate** — see "Redeploy + migrate
(v2)" below. Never call `new` again after the first deploy.

**v3 (2026-11-07): NEP-413 verification fix — code-only redeploy, NO
migrate.** The v3 code changes only the signature verification
(tag + SHA-256) and the version number; the state schema is
identical to v2, so the stored state keeps working as-is. Deploy the
new wasm the same way as v2 (step 1-2 of "Redeploy + migrate (v2)"
below) and STOP there — do NOT call `migrate`. Calling `migrate` on
v2 state panics ("contract state v1 not found") and leaves the state
untouched, so it is harmless but pointless. After deploy, verify
`get_version` returns **3**. New wasm: 222,775 bytes, SHA-256
`2894e4310c6972a2420bb02502cb60b9b84b13b51308966a9cca79669ee20835`.

There are two ways to deploy. **The browser path is BLOCKED by
Meteor** — it refuses the DeployContract action ("Contract deployment
blocked"). The CLI path is the one that works.

## Path A — deploy from the browser (BLOCKED by Meteor, not recommended)

1. Build the contract:
   ```bash
   cd contract
   ./build-optimized.sh
   # → twinnear.wasm
   ```
2. Run the frontend:
   ```bash
   cd ../frontend
   npm install
   npm run dev   # → http://localhost:5173
   ```
3. Open the app, connect **Meteor Wallet** with the `twinnear.testnet`
   account, go to the **Deploy** page.
4. Pick `contract/twinnear.wasm` in the file picker. The page shows
   its size and SHA-256 — check it matches the build below.
5. Click **Deploy + initialize**. One wallet-signed transaction sends
   `DeployContract` + init `new` (owner `twinnear.testnet`).
6. Press **Verify** — the page checks the contract exists and reads the
   owner back with `get_owner`.

> ⚠️ **Meteor blocks this path.** When the DeployContract action is
> signed, Meteor shows "Contract deployment blocked" and the Approve
> button stays disabled (verified 2026-11-07). The form stays on the
> page for other wallets, or in case Meteor changes its policy — but
> do not plan a demo around it. Use Path B.

## Path B — deploy from the terminal (near-cli-rs) ✅ the working path

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
local OS keychain. The `twinnear.testnet` key currently lives only in
Meteor Wallet on the user's phone, so before the CLI can sign you must
import it yourself on your own machine:

```bash
# Do this on YOUR OWN machine, with YOUR OWN key. Never send the
# private key or seed phrase to anyone, including this agent.
near account import-account using-private-key 'ed25519:...' twinnear.testnet network-config testnet save-to-legacy-keychain
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

## Termux (phone) — the path that deployed v1

The user's phone runs the deploy from Termux (proot-distro Ubuntu),
because the desktop binary is x86_64 and the phone is aarch64:

- Ubuntu in proot-distro, near-cli-rs **aarch64** binary, version
  **0.31.1**, SHA-256
  `13d3103aa850294e6b9a2ed7832eb2abbcdf91986935b7edee80c304cef502ac`.
- Headless / no OS keychain on Termux, so sign with the **legacy
  keychain**: `sign-with-legacy-keychain` (desktop uses
  `sign-with-keychain`). Import the key the same way, ending in
  `save-to-legacy-keychain` (see Path B above).

## Redeploy + migrate (v2 upgrade)

The v1 contract is already live with real invoices. The upgrade
replaces the code and migrates the state in place — the ledger
survives. Two steps, both from the CLI:

```bash
# 1. Deploy the v2 wasm WITHOUT init — no prepaid-gas / attached-deposit
#    arguments here: `without-init-call` takes none, the chain goes
#    straight to network-config. (Verified against near-cli-rs 0.31.1
#    --help, 2026-11-07.)
near contract deploy twinnear.testnet use-file twinnear.wasm without-init-call network-config testnet sign-with-legacy-keychain send

# 2. Migrate the state (owner only, one tx). Converts every v1 invoice
#    to the v2 shape (currency=Near, items=[], tax=0, subtotal=amount).
near contract call-function as-transaction twinnear.testnet migrate json-args '{}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as twinnear.testnet network-config testnet sign-with-legacy-keychain send

# 3. Verify:
near contract call-function as-read-only twinnear.testnet get_version json-args '{}' network-config testnet now
# → 2
near contract call-function as-read-only twinnear.testnet get_invoice json-args '{"id": 1}' network-config testnet now
# → invoice #1 intact (same amount, description, status, due date)
```

> ⚠️ **Never call `new` again after a redeploy.** `new` re-initializes
> the contract and would wipe the ledger. The Deploy page's
> "Redeploy code only (no init)" button sends DeployContract alone;
> `migrate` still has to run from the CLI afterwards.

Current build (v1, 2026-11-07, phase 2 + QA fixes, optimized):
- Size: **194,009 bytes** (raw cargo build 242,681 bytes after `strip`)
- SHA-256: `5c1c22243b9ce154d7f31da2d34185067208d2030647060a2869d1f6c6e09b1b`
- 40/40 unit tests pass (was 12 before the QA-fix contract changes).

The v2 wasm SHA will be published by the coordinator when the
contract build lands — update `EXPECTED_WASM_SHA256` in
`frontend/src/lib/config.ts` then (never guess it).

> Storage: a ~194 KB wasm locks ~1.9 NEAR of storage stake on
> the account (1 NEAR per 100 KB). With 4 NEAR in the account, about
> 2.1 NEAR stays liquid after deploy — keep demo invoices small
> (0.05–0.1 NEAR) and top the account up from the faucet again if it
> runs low: https://near-faucet.io

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
- **Browser deploy shows a wallet error about DeployContract**: Meteor
  blocks the DeployContract action — use Path B instead and report the
  exact error.
- **`cargo install near-cli-rs` fails with "No space left on device"**:
  the install uses a large temp dir. Set `TMPDIR` to a roomy directory
  first (this VM: `export TMPDIR=$HOME/.tmp-build`) and retry.
- **`migrate` fails with "only the owner can migrate"**: the call must
  be signed as `twinnear.testnet` (the `sign-as` in the command above).
- **`get_version` returns nothing / "method not found"**: the v2 code
  has not landed yet — redeploy first, then migrate.
