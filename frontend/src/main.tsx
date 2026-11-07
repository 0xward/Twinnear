import React from "react";
import ReactDOM from "react-dom/client";
import { Buffer } from "buffer";
import { HashRouter } from "react-router-dom";
import App from "./App";
import "./index.css";
import "@near-wallet-selector/modal-ui/styles.css";

// near-api-js / wallet-selector reference the Node `Buffer` global when
// serialising transactions (e.g. DeployContract). The Vite `buffer`
// alias only fixes `import "buffer"`; without this global the deploy
// flow throws "Buffer is not defined" at runtime in the browser.
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
