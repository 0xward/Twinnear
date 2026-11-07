/**
 * Vercel serverless function: POST /api/relay/create-invoice
 *
 * Gasless meta-transaction relay. The browser client posts the signed
 * NEP-413 payload; this function verifies it and submits
 * `create_invoice_meta` from the funded relayer account. Request and
 * response shapes are identical to the standalone server. Logic lives
 * in ./_core.mjs (underscore prefix = not a route).
 *
 * Note: Vercel parses a JSON request body into req.body automatically.
 * Note: RELAYER_API_KEY stays UNSET in production on purpose - the
 * browser client cannot hold a secret. Protection is the seller
 * allowlist (RELAYER_ALLOWED_SELLERS) plus the NEP-413 signature, the
 * full-access key check, on-chain verification and the rate limit.
 * See relayer-server/README.md (H-04).
 */
import { dispatch, getCorsHeaders } from "./_core.mjs";

export default async function handler(req, res) {
  for (const [k, v] of Object.entries(getCorsHeaders(req.headers.origin))) {
    res.setHeader(k, v);
  }
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  const result = await dispatch({
    method: req.method,
    path: "/relay/create-invoice",
    headers: req.headers,
    body: req.body,
  });
  return res.status(result.status).json(result.body);
}
