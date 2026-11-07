/**
 * Fiat estimates (USD) — display only, never a settlement rate.
 *
 * NEAR/USD comes from the CoinGecko public API (no key), cached in
 * localStorage for 5 minutes so the ledger does not hit the API on
 * every render. USDC is treated as ≈ $1.00 ("approx.").
 *
 * A failed fetch hides the estimate silently (the caller renders
 * nothing) — a missing price is not an error the user needs to see.
 */

const CACHE_KEY = "twinnear.fiat-cache.v1";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd";

interface FiatCache {
  priceUsd: number;
  fetchedAt: number;
}

function readCache(): FiatCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FiatCache;
    if (
      typeof parsed.priceUsd !== "number" ||
      !Number.isFinite(parsed.priceUsd) ||
      parsed.priceUsd <= 0 ||
      typeof parsed.fetchedAt !== "number"
    ) {
      return null;
    }
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(priceUsd: number): void {
  try {
    const entry: FiatCache = { priceUsd, fetchedAt: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Storage full / private mode — estimates just won't be cached.
  }
}

/**
 * Current NEAR price in USD, or null when the price is unknown
 * (offline, API down, or the cached value expired and the refetch
 * failed). Callers hide the estimate when this is null.
 */
export async function getNearUsdPrice(): Promise<number | null> {
  const cached = readCache();
  if (cached) return cached.priceUsd;
  try {
    const res = await fetch(COINGECKO_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { near?: { usd?: number } };
    const price = body?.near?.usd;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      return null;
    }
    writeCache(price);
    return price;
  } catch {
    return null;
  }
}

/** "1234.5" → "$1,234.50". */
export function formatUsd(value: number): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
