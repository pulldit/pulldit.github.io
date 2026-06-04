# Pulldit — TODO: layout gap, collapsible stats, clear-data modal

## Phase 1 — Consistent vertical rhythm (gap fix)
- [x] 1.1 `styles.css` — stop `.statsbox` from overriding `.panel` margin (asymmetric 0/1rem)
- [x] 1.2 `styles.css` — `.status:empty { display: none }` so the empty status line adds no gap
- [x] 1.3 Verify gaps between all top-level panels are equal

## Phase 2 — Collapsible statistics panels (collapsed by default) + persisted UI state
- [ ] 2.1 `index.html` — convert fetch-stats + download-stats to `<details>` with summary
        (title + status badge) and an inner grid container; collapsed by default
- [ ] 2.2 `styles.css` — collapsible summary + badge colour variants + stats title icon
- [ ] 2.3 `src/app.js` — split buildStatGrid into buildStatCells (grid only); update
        renderFetchStats/Idle + renderDownloadStats to set the badge + inner grid + show panel
- [ ] 2.4 `src/app.js` — persist open/closed state of all collapsible panels
        (proxy/fetch/download/history) in `rd.ui.v1`, restore on init

## Phase 3 — Custom "Clear stored data" modal
- [ ] 3.1 `index.html` — accessible modal (role=dialog, backdrop) with per-category
        checkboxes: History, Statistics, Proxy settings, Filters, Fetch options (+ select all)
- [ ] 3.2 `styles.css` — modal layout (backdrop, centred card, actions), no default UA dialog
- [ ] 3.3 `src/app.js` — open/close (button, Cancel, backdrop, ESC), focus management
- [ ] 3.4 `src/app.js` — clear selected categories: remove keys + reset in-memory + re-render
- [ ] 3.5 Wire the history "Clear stored data…" button to open the modal

## Phase 4 — Verify & ship
- [ ] 4.1 `npm run build` green + control-char scan + serve smoke
- [ ] 4.2 bump cache-bust version; commit + push each phase; confirm deploy + 0 alerts
