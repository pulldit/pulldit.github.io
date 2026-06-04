# Pulldit — Feature TODO: Statistics + Discard workflow

Two features:
1. Comprehensive statistics for the fetch phase AND the download/ZIP phase
   (success / failed / timeout / blocked / too-large, counts by type & source,
   total size, elapsed, speed, success rate, NSFW count, dropped posts, …).
2. Discard workflow: preview loaded media, discard unwanted items, keep + save only
   the rest (single download / ZIP operate on the kept set; discarded can be restored).

## Phase A — Stats module (pure, tested)
- [x] A1 `src/stats.js` — formatBytes / formatDuration / formatSpeed / formatPercent
- [x] A2 `src/stats.js` — classifyError (timeout/too-large/blocked/network/error)
- [x] A3 `src/stats.js` — aggregateDownload(results), summarizeItems(items)
- [x] A4 `test/stats.test.js` — formatting, classification, aggregation

## Phase B — Fetch statistics (data layer)
- [x] B1 `src/reddit.js` — normalizeListing returns `stats` (postsScanned, postsWithMedia,
        dropped, galleries, byType, bySource, nsfw, capped) without breaking existing shape
- [x] B2 `src/proxy.js` — fetchJson reports listing byte size via optional `opts.stats`
- [x] B3 `test/reddit.test.js` — assert stats fields

## Phase C — Download statistics (data layer)
- [ ] C1 `src/download.js` — downloadZip returns per-file `files[]` + totalBytes + elapsedMs,
        emits running totals via onProgress; tolerant of per-file failure
- [ ] C2 `src/download.js` — downloadSingle returns byte count
- [ ] C3 `test/download.test.js` — keep filename tests green (logic unchanged)

## Phase D — Discard / keep model (controller)
- [ ] D1 `src/app.js` — discarded Set, showDiscarded toggle; viewItems/keptItems/discardedItems
- [ ] D2 `src/app.js` — per-card discard (✕) + restore; downloads operate on kept set
- [ ] D3 `src/app.js` — discard control bar (kept/discarded counts, show/restore)

## Phase E — UI (markup + styles)
- [ ] E1 `index.html` — stats panel (fetch + download) + discard bar + per-card discard button
- [ ] E2 `styles.css` — stats grid, discard bar, dimmed discarded cards

## Phase F — Wire it all (controller)
- [ ] F1 `src/app.js` — fetch: measure time, render fetch stats
- [ ] F2 `src/app.js` — ZIP/selected: live + final download stats, per-file reasons
- [ ] F3 `src/app.js` — keep selection/filters/discard consistent; persist nothing fragile

## Phase G — Verify & ship
- [ ] G1 `npm run build` green + control-char scan + local serve smoke
- [ ] G2 commit + push each phase; confirm Pages deploy + 0 alerts
