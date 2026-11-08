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
 * 2026-11-08, v5: funded milestones + programmable splits, 123 unit
 * tests; 269,450 bytes, 123/123 unit tests pass).
 * Compare a candidate wasm against this hash before deploying (M-05)
 * — update this on every contract rebuild.
 */
export const EXPECTED_WASM_SHA256 =
  "36c387190a5fe7c7a57090bd0ae005623530ace91c33599eb0f89a594132d4e0";
