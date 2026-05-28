# RTBALI · Expedition Command Center

Offline-first planner & cost tracker for the **Bintaro → Bali** family road trip
(12–20 Jun 2026 · 4 adults + 1 child · Toyota Fortuner).

## Run offline

**1. Open the single-file app.**
Open `RTBALI_command_center.html` directly in any browser, even from a USB stick.
All seed data is embedded and edits are saved in the browser (`localStorage`).

**2. Use the GitHub Pages app.**
Open the repository root through GitHub Pages. `index.html` is the deploy entry
point, `data/db.json` is the committed local database, and `sw.js` caches the app
shell so it can reopen offline after the first successful visit.

On **Reset**, the app tries to reload `data/db.json` when served from GitHub Pages
or a local server. If it is opened through `file://`, it falls back to the embedded
seed database and still works offline.

## What's new vs the old app

- **Fixed data bugs**: the Lovina restaurant list was mangled on Excel import
  (header row eaten as keys) and never shown — it's now cleaned and surfaced in a
  **Dining** tab. A checklist task had a raw Excel serial date (`46187`) — now
  correctly **14 Jun 2026**. Sources are now visible too.
- **Real numbers on the dashboard**: KPIs now read the detailed **Cost Plan**
  (≈ Rp 5.35 M with buffer, 2,432 km, ~270 L diesel) instead of the empty budget
  table, so the dashboard is useful *before* you spend anything.
- **Smart settlement engine**: honors each expense's split type (Shared by Units
  2.5/2.5, Equal 50/50, TJ-only, EK-only) and TBD payers, instead of a naive 50/50.
- **Route map**: a schematic Java→Bali map with status-coloured overnight stops and
  ferry crossings, plus a per-leg distance breakdown.
- **Trip countdown**, per-day planned-cost chart, progress rings, grouped checklist
  with one-tap status cycling, sortable tables, dark mode, search & filters,
  validated import/export, and a print layout.

## Backup / sync

Use **Export** to download the full database as JSON. To update the committed
local database, replace `data/db.json` with the exported file and commit it to git.
Keep root `db.json` as a portable copy for older/manual workflows. **Import**
restores a saved export and validates its structure before applying.

## GitHub layout

- `index.html` — GitHub Pages entry point.
- `RTBALI_command_center.html` — portable single-file app.
- `data/db.json` — git-tracked local database seed.
- `db.json` — root copy of the same seed for direct/manual use.
- `sw.js` and `manifest.webmanifest` — offline cache / install support.

## Data model (`db.json`)

`metadata`, `settings` (currency, TJ/EK split units, buffer rate), `lists`,
`tripPlans`, `accommodations`, `checklist`, `expenses`, `categoryDetails`
(the cost-plan source of truth), `categorySettings`, `restaurants`, `sources`.
