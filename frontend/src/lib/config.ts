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
 * 2026-11-07, v4: USDC spend-guard caps + 90 unit tests (39
 * adversarial/conformance tests added in v4); 224,493 bytes,
 * 90/90 unit tests pass).
 * Compare a candidate wasm against this hash before deploying (M-05)
 * — update this on every contract rebuild.
 */
export const EXPECTED_WASM_SHA256 =
  "3c1aa19e48f430be40210970961bc8e57159336bb540587ac8c9c19aced82c57";
