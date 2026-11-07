/** Twinnear configuration — NEAR testnet. */
export const NETWORK_ID = "testnet";
export const RPC_URL = "https://rpc.testnet.near.org";
export const EXPLORER_URL = "https://testnet.nearblocks.io";
/** Contract account. Deploy it first — see README "Deploy the contract"
 *  (the /deploy page does this from the browser). Not yet deployed as of
 *  2026-11-06; the banner in App.tsx says so until the code is live. */
export const CONTRACT_ID = "twinnear.testnet";
/**
 * SHA-256 of the current optimized build (`contract/twinnear.wasm`,
 * 2026-11-06, after the QA round-2 closing fixes N-1/N-3/N-4a).
 * The Deploy page warns when a picked file differs (M-05) — update
 * this on every contract rebuild.
 */
export const EXPECTED_WASM_SHA256 =
  "5c1c22243b9ce154d7f31da2d34185067208d2030647060a2869d1f6c6e09b1b";
