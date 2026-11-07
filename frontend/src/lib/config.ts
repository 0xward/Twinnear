/** Twinnear configuration — NEAR testnet. */
export const NETWORK_ID = "testnet";
export const RPC_URL = "https://rpc.testnet.fastnear.com";
export const EXPLORER_URL = "https://testnet.nearblocks.io";
/** Contract account. Live on testnet since 2026-11-07 (v1); the v2
 *  upgrade is deployed separately — see DEPLOY.md "Redeploy +
 *  migrate". */
export const CONTRACT_ID = "twinnear.testnet";
/**
 * SHA-256 of the current optimized build (`contract/twinnear.wasm`,
 * 2026-11-07, v2: USDC + line items/tax + migrate; 213,007 bytes,
 * 50/50 unit tests pass).
 * Compare a candidate wasm against this hash before deploying (M-05)
 * — update this on every contract rebuild.
 */
export const EXPECTED_WASM_SHA256 =
  "dbd630d0c3ce6cf2b5afacf2b9d1f6b2be3fe2760f2d6eac2b452be3bb5d49a0";
