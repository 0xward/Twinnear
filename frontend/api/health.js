/**
 * Vercel serverless function: GET /api/health
 *
 * Same response shape as the standalone server's GET /health.
 * Logic lives in ./relay/_core.mjs (underscore prefix = not a route).
 */
import { dispatch, getCorsHeaders } from "./relay/_core.mjs";

export default async function handler(req, res) {
  for (const [k, v] of Object.entries(getCorsHeaders(req.headers.origin))) {
    res.setHeader(k, v);
  }
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  const result = await dispatch({ method: req.method, path: "/health", headers: req.headers });
  return res.status(result.status).json(result.body);
}
