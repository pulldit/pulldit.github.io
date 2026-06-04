# Pulldit — TODO: focus bug, persistence, history, visible stats

## Phase 1 — Fix focus-ring bug
- [x] 1.1 `styles.css` — change `input:focus, select:focus` to `:focus-visible` so
        mouse-clicking a checkbox/radio no longer shows the heavy orange outline
        (keyboard navigation still shows a clear ring; text inputs still ring on focus)
- [x] 1.2 Verify chips + proxy radios no longer outline on click

## Phase 2 — Persist fetch options
- [ ] 2.1 `src/app.js` — save sort/time/limit to localStorage (`rd.options.v1`)
- [ ] 2.2 `src/app.js` — load + apply them on init; save on change
        (proxy + filters already persist)

## Phase 3 — History (fetched / downloaded / discarded / restored) + clear
- [ ] 3.1 `src/history.js` — pure helpers: capList, describeEntry (+ HISTORY_KEY, MAX)
- [ ] 3.2 `test/history.test.js` — cap + describe
- [ ] 3.3 `index.html` — collapsible History panel + Clear button + list
- [ ] 3.4 `styles.css` — history list styles
- [ ] 3.5 `src/app.js` — load/save/render history; record fetch, download, zip,
        discard, restore events; wire Clear button

## Phase 4 — Make statistics always visible
- [ ] 4.1 `index.html` — fetch-stats panel always visible (remove `hidden`)
- [ ] 4.2 `src/app.js` — render an idle/empty fetch-stats state on init
- [ ] 4.3 `index.html` — cache-bust entry assets (styles.css, src/app.js `?v=`) so
        deploys are picked up without a manual hard refresh

## Phase 5 — Verify & ship
- [ ] 5.1 `npm run build` green + control-char scan + local serve smoke
- [ ] 5.2 commit + push each phase; confirm Pages deploy + 0 alerts
