import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // L-02: wallet-selector / near-api-js dependencies import Node's
    // `buffer` and `util`. Without these aliases Vite externalises them
    // and the code paths that call Buffer.from() (e.g. serialising tx
    // args) throw at runtime in the browser. `http`/`https`/`crypto`
    // warnings remain — those imports live in Node-only branches
    // (@near-js fetch / local execution) that the browser never runs.
    alias: {
      buffer: "buffer",
      util: "util",
    },
  },
});
