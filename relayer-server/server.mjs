/**
 * Twinnear relayer server (thin wrapper, local dev).
 *
 * All relayer logic lives in the shared core at
 * ../frontend/api/relay/_core.mjs - the same code the Vercel
 * serverless functions run in production. This file only adapts a
 * plain Node http server to it: it reads the request body stream,
 * hands the request to dispatch(), and writes the JSON result back.
 *
 * Run it: `npm start` (listens on RELAYER_PORT, default 3001).
 * Production runs the same core as Vercel functions under
 * https://twinnear.vercel.app/api - see relayer-server/README.md.
 *
 * Environment: same names as the core (see _core.mjs header), plus
 *   RELAYER_PORT              default 3001
 *   RELAYER_MAX_BODY_BYTES    default 65536 (M-07)
 */

import http from "node:http";
import {
  HttpError,
  dispatch,
  getCorsHeaders,
  getStartupNotes,
  getStartupSummary,
  getStartupWarnings,
} from "../frontend/api/relay/_core.mjs";

const PORT = Number(process.env.RELAYER_PORT ?? 3001);
const MAX_BODY_BYTES = Number(process.env.RELAYER_MAX_BODY_BYTES ?? 65536);

/** Timestamped server-side audit log (L-11). */
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer((req, res) => {
  // CORS: only origins on the allowlist (H-04), never `*`.
  for (const [k, v] of Object.entries(getCorsHeaders(req.headers.origin))) {
    res.setHeader(k, v);
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "GET" && req.url === "/health") {
    return dispatch({ method: "GET", path: "/health", headers: req.headers }).then(
      (result) => sendJson(res, result.status, result.body),
    );
  }
  if (req.method === "POST" && req.url === "/relay/create-invoice") {
    return (async () => {
      try {
        const raw = await readBody(req);
        const result = await dispatch({
          method: "POST",
          path: "/relay/create-invoice",
          headers: req.headers,
          body: raw,
        });
        return sendJson(res, result.status, result.body);
      } catch (e) {
        if (e instanceof HttpError) {
          return sendJson(res, e.status, { error: e.message });
        }
        log("relay error", e instanceof Error ? e.message : String(e));
        return sendJson(res, 500, { error: "Internal relayer error" });
      }
    })();
  }
  return sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  log(getStartupSummary(PORT));
  for (const note of getStartupNotes()) {
    log("NOTE:", note);
  }
  const warnings = getStartupWarnings();
  if (warnings.length > 0) {
    log(
      "WARNING: relayer is running OPEN - " +
        warnings.join("; ") +
        ". Set these env vars before exposing this server beyond localhost.",
    );
  }
});
