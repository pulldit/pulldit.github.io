# Bugfix TODO — 2026-06-04

## Analysis findings (verified via live network tests)
- **Reddit IP-blocks datacenter ranges** with `HTTP 403 Blocked` / `429`, *independent of User-Agent*
  (tested: Chrome UA, Googlebot, empty, custom — all 403 from a datacenter IP). Residential
  browser IPs are NOT blocked → **Direct mode is the realistic default for most users**.
- `corsproxy.io` now requires a **paid plan**: `{"error":"Server-side requests are not allowed
  on your plan"}` → HTTP 403 always. DEAD for free use.
- `thingproxy.freeboard.io` → connection fails (HTTP 000). DEAD.
- `allorigins.win` and `api.codetabs.com` have **working CORS transport** (ACAO present) — the only
  viable free relays. They still depend on Reddit not blocking their server IP at that moment.
- Conclusion: no client code can force Reddit to serve JSON to a blocked datacenter IP. Correct fix =
  replace dead proxies, add **automatic multi-proxy fallback**, **accurate block/rate-limit detection**,
  and honest guidance. Keep Direct mode (works on home connections).

## Fix 1 — Gap between summary title and content in stats panels
- [x] `#fetch-stats` / `#download-stats` have no top margin (proxy/history panels do) → add `margin-top`
- [x] Bump cache-bust `?v=4` → `?v=5` (styles.css + app.js)
- [x] build + commit

## Fix 2 — Fetch statistics must accumulate (sum) + persist, not overwrite
- [x] Add pure `accumulateFetchStats(prev, sample)` + `emptyFetchTotals()` to `stats.js`
- [x] Unit tests for accumulation (success sums, failure/timeout counters, no overwrite)
- [x] Persist cumulative totals under `fetchCum` (alongside last-fetch `fetch`) in `app.js`
- [x] Render two grouped sections: "Last fetch" + "All time · N fetches" (`buildStatGroups`)
- [x] CSS for `.stat-group` / `.stat-group-title`
- [x] Restore cumulative on page load; clear with the existing stats clear
- [x] build + commit

## Fix 3 — Proxy modes actually work (or fail honestly)
- [ ] Replace `PUBLIC_PROXIES`: drop dead corsproxy.io + thingproxy; keep allorigins (`/raw`) + codetabs
      (both raw passthrough → work for listing JSON *and* media bytes)
- [ ] `fetchJson`: automatic fallback chain (selected proxy first, then the rest) with
      block/rate-limit/HTML detection (`classifyBlockText`)
- [ ] Update CSP `connect-src` to the new proxy origins
- [ ] Update `#public-proxy` select options
- [ ] Migrate stored `publicId` default (`corsproxy` → first valid) + validation in `app.js`
- [ ] Accurate `handleFetchError` messages per mode (direct / public / worker)
- [ ] Update `proxy.test.js` for the new proxy list + fallback behavior
- [ ] build + commit

## Cleanup
- [ ] Remove this TODO.md, final build + commit
