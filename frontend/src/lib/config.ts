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
 * 2026-11-09, v5 + audit fixes (A6/B1/B2/B3/B4/B10/B12), 272,817 bytes,
 * 129/129 unit tests pass).
 * Compare a candidate wasm against this hash before deploying (M-05)
 * — update this on every contract rebuild.
 */
export const EXPECTED_WASM_SHA256 =
  "420800818f1220fb6b8b04f16fee50eeb51638700f48a50dd87c8fe17ca0726c";
