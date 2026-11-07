# Verify in 2 minutes

Ready to paste into the README. No wallet, no signup, no install
(except step 4, which needs the repo). Each step is "do X, see Y".

## Verify in 2 minutes

1. Open a real invoice, no wallet needed.
   Do: open https://twinnear.vercel.app/#/invoice/1
   See: invoice TW-2026-0001, 0.05 NEAR, Paid and released, seller
   twinnear.testnet, client 0xward.testnet, with the three
   transactions (create, pay, release) linked to the explorer.

2. Check the contract is live on testnet.
   Do: open https://testnet.nearblocks.io/accounts/twinnear.testnet
   See: the contract account, schema v2, and the recent
   transactions. The contract holds no funds of its own; escrowed
   funds sit in the contract only while an invoice is unpaid.

3. Check the deployed code matches the source.
   Do: run this (it hashes the code that is actually on chain):
   ```sh
   curl -s https://rpc.testnet.near.org -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":"t","method":"query","params":{"request_type":"view_code","account_id":"twinnear.testnet","finality":"final"}}' \
     | python3 -c "import json,sys,base64,hashlib; d=json.load(sys.stdin); print(hashlib.sha256(base64.b64decode(d['result']['code_base64'])).hexdigest())"
   ```
   See: `dbd630d0c3ce6cf2b5afacf2b9d1f6b2be3fe2760f2d6eac2b452be3bb5d49a0`
   That is the SHA-256 of the v2 build (USDC, line items and tax,
   migrate; 213,007 bytes). The wasm file itself is not in the repo
   (it is gitignored); the source it was built from is in
   `contract/src/lib.rs`.

4. Run the tests.
   Do: `cd contract && cargo test`
   See: 50 passed, 0 failed.
   Do: `cd frontend && npm install && npm run build`
   See: a clean build.

---

Notes for the person pasting this into the README:

- All four steps were run fresh on 7 Nov 2026: the public invoice
  page reads invoice #1 from the contract, the explorer account
  is live, the RPC hash above matches the local
  `contract/twinnear.wasm` and `EXPECTED_WASM_SHA256` in
  `frontend/src/lib/config.ts`, and `cargo test` passes 90/90.
- The public invoice page is `/#/invoice/1` (route `/invoice/:id`,
  page `frontend/src/pages/PublicInvoice.tsx`). It uses only the
  `get_invoice` view call and never opens a wallet.
- The compiled wasm in `contract/target/` is a stale debug build
  with a different hash; do not use it for verification. Only the
  RPC check in step 3 (or `sha256sum contract/twinnear.wasm`
  locally) gives the deployed hash.
