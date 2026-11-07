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
  "2894e4310c6972a2420bb02502cb60b9b84b13b51308966a9cca79669ee20835";
