# Deploying Twinnear to NEAR testnet

Target account: **`twinnear.testnet`** (created in Meteor Wallet, funded
with 4 NEAR from the faucet — 0.2 NEAR is the storage reserve, ~3.8 NEAR
usable).

Contract status: **v4 LIVE** since 2026-11-07 (deployed via Termux +
near-cli-rs, redeploy + migrate, wasm 224,493 bytes, SHA-256
`3c1aa19e48f430be40210970961bc8e57159336bb540587ac8c9c19aced82c57`).
The v2 upgrade was a **redeploy + migrate** — see "Redeploy + migrate
(v2)" below. Never call `new` again after the first deploy.

**v5 (2026-11-08, NOT YET DEPLOYED — code ready, awaiting the
owner's Termux run): funded milestones + programmable splits (123
unit tests total: 90 old + 33 new). This is a redeploy + MIGRATE
upgrade — the state schema DOES change: the contract gains two new
maps, `milestones` (prefix `b"k"`) and `splits` (prefix `b"s"`), so
after deploying the v5 wasm you MUST call `migrate` (owner only, one
tx). Migration moves every invoice (#1–#4), the NEAR policies, the
USDC policies, the relayer, the meta nonces, and the escrow accounting
over untouched and adds the two initially empty maps — nothing is
reset, and the `Invoice` struct itself is byte-identical to v4. A
second `migrate` panics harmlessly and leaves the state untouched.
After migrate, verify `get_version` returns 5 and invoice #1 is
still Paid/released. New wasm: 269,450 bytes, SHA-256
`36c387190a5fe7c7a57090bd0ae005623530ace91c33599eb0f89a594132d4e0`.
Download it from the repo:
`https://raw.githubusercontent.com/0xward/Twinnear/main/contract/twinnear.wasm`
— then check the SHA before deploying (see the exact Termux
commands in "Redeploy + migrate (v5)" below).

**v4 (2026-11-07, DEPLOYED 22:26 WIB): USDC spend-guard caps + 39
adversarial / conformance tests (90 unit tests total). This is a
redeploy + MIGRATE upgrade — unlike v3, the state schema DOES
change: the contract gains a new `usdc_policies` map (prefix `b"u"`),
so after deploying the v4 wasm you MUST call `migrate` (owner only,
one tx). Migration moves every invoice (#1–#4), the NEAR policies,
the relayer, the meta nonces, and the escrow accounting over
untouched and adds an initially empty USDC-policy map — nothing is
reset. A second `migrate` panics harmlessly and leaves the state
untouched. After migrate, verify `get_version` returns 4 and invoice
#1 is still Paid/released. New wasm: 224,493 bytes, SHA-256
`3c1aa19e48f430be40210970961bc8e57159336bb540587ac8c9c19aced82c57`.
Download it from the repo:
`https://raw.githubusercontent.com/0xward/Twinnear/main/contract/twinnear.wasm`
— then check the SHA before deploying (see the exact Termux
commands in "Redeploy + migrate (v4)" below).

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

## Redeploy + migrate (v4 upgrade)

Same shape as the v2 upgrade, but the migration is different: v4
does NOT rewrite any invoice or policy — it only adds the new,
initially empty `usdc_policies` map. Run from Termux (proot-distro
Ubuntu, near-cli-rs 0.31.1, `sign-with-legacy-keychain`):

```bash
# 0. Download the v4 wasm and CHECK the SHA before deploying.
curl -sL -o twinnear.wasm \
  https://raw.githubusercontent.com/0xward/Twinnear/main/contract/twinnear.wasm
sha256sum twinnear.wasm
# → 3c1aa19e48f430be40210970961bc8e57159336bb540587ac8c9c19aced82c57
#    (224,493 bytes). If the hash differs, STOP — do not deploy.

# 1. Deploy the v4 wasm WITHOUT init.
near contract deploy twinnear.testnet use-file twinnear.wasm without-init-call network-config testnet sign-with-legacy-keychain send

# 2. Migrate the state v3 → v4 (owner only, one tx). REQUIRED for v4
#    — unlike v3, the state schema changed. Moves invoices #1–#4, the
#    NEAR policies, the relayer, meta nonces and escrow accounting over
#    untouched; adds an empty USDC-policy map. A second migrate panics
#    harmlessly and leaves the state untouched.
near contract call-function as-transaction twinnear.testnet migrate json-args '{}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as twinnear.testnet network-config testnet sign-with-legacy-keychain send

# 3. Verify:
near contract call-function as-read-only twinnear.testnet get_version json-args '{}' network-config testnet now
# → 4
near contract call-function as-read-only twinnear.testnet get_invoice json-args '{"id": 1}' network-config testnet now
# → invoice #1 intact (0.05 NEAR, Paid, released)
near contract call-function as-read-only twinnear.testnet get_usdc_policy json-args '{"account_id": "0xward.testnet"}' network-config testnet now
# → null (no USDC policy set yet — expected)

# 4. Re-test the gasless flow end to end (the relayer key and the
#    NEP-413 verification are unchanged, but a redeploy is a redeploy):
#    create a small invoice from the site as twinnear.testnet with the
#    relayer, and confirm it lands on chain.
```

## Redeploy + migrate (v5 upgrade)

Same shape as the v4 upgrade: v5 adds two new maps (`milestones`,
`splits`) and leaves every stored value untouched. Run from Termux
(proot-distro Ubuntu, near-cli-rs 0.31.1, `sign-with-legacy-keychain`):

```bash
# 0. Download the v5 wasm and CHECK the SHA before deploying.
curl -sL -o twinnear.wasm \
  https://raw.githubusercontent.com/0xward/Twinnear/main/contract/twinnear.wasm
sha256sum twinnear.wasm
# → 36c387190a5fe7c7a57090bd0ae005623530ace91c33599eb0f89a594132d4e0
#    (269,450 bytes). If the hash differs, STOP — do not deploy.

# 1. Deploy the v5 wasm WITHOUT init.
near contract deploy twinnear.testnet use-file twinnear.wasm without-init-call network-config testnet sign-with-legacy-keychain send

# 2. Migrate the state v4 → v5 (owner only, one tx). REQUIRED for v5
#    — the state schema changed. Moves invoices #1–#4, the NEAR and
#    USDC policies, the relayer, meta nonces and escrow accounting over
#    untouched; adds the empty milestones and splits maps. A second
#    migrate panics harmlessly and leaves the state untouched.
near contract call-function as-transaction twinnear.testnet migrate json-args '{}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as twinnear.testnet network-config testnet sign-with-legacy-keychain send

# 3. Verify:
near contract call-function as-read-only twinnear.testnet get_version json-args '{}' network-config testnet now
# → 5
near contract call-function as-read-only twinnear.testnet get_invoice json-args '{"id": 1}' network-config testnet now
# → invoice #1 intact (0.05 NEAR, Paid, released)
near contract call-function as-read-only twinnear.testnet get_milestones json-args '{"invoice_id": 1}' network-config testnet now
# → [] (invoice #1 is a plain invoice, no milestones — expected)
near contract call-function as-read-only twinnear.testnet get_splits json-args '{"invoice_id": 1}' network-config testnet now
# → [] (no splits — expected)

# 4. Re-test the gasless flow end to end (the NEP-413 message gained
#    two trailing fields, milestones + splits JSON — the relayer and
#    the frontend both build the new message, but a redeploy is a
#    redeploy): create a small invoice from the site as
#    twinnear.testnet with the relayer, and confirm it lands on chain.
#    Then create one small milestone invoice (2 parts) from the site
#    and walk one milestone through submit → approve on chain.
```

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
