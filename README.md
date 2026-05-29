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

- **Fixed data bugs**: a checklist task had a raw Excel serial date (`46187`) —
  now correctly **14 Jun 2026**. Sources are now visible too.
- **Real numbers on the dashboard**: KPIs now read the detailed **Cost Plan**
  (≈ Rp 5.35 M with buffer, 2,432 km, ~270 L diesel) instead of the empty budget
  table, so the dashboard is useful *before* you spend anything.
- **Smart settlement engine**: honors each expense's split type (Shared by Units
  2.5/2.5, Equal 50/50, TJ-only, EK-only) and TBD payers, instead of a naive 50/50.
- **Route map**: a GeoJSON-backed Java→Bali map with status-coloured overnight stops and
  ferry crossings, plus a per-leg distance breakdown.
- **Fuel Log**: fill-up KPIs, sortable odometer/liter/cost table, automatic
  liters × price total, plan variance, and km/L efficiency from odometer deltas.
- **Trip countdown**, per-day planned-cost chart, progress rings, grouped checklist
  with one-tap status cycling, sortable tables, dark mode, search & filters,
  validated import/export, and a print layout.

## Backup / sync

Use **Export** to download the full database as JSON. To update the committed
local database, replace `data/db.json` with the exported file and commit it to git.
Keep root `db.json` as a portable copy for older/manual workflows. **Import**
restores a saved export and validates its structure before applying.

## Firebase + Telegram group mode

This repo includes an optional Firebase backend for a 4-person shared expense
tracker. The GitHub Pages app still works offline; Firebase is only used when you
add a local `firebase-config.json`.

What it adds:

- Telegram group bot manual expense commands.
- Receipt photo upload to Firebase Storage.
- OCR draft expenses using Google Cloud Vision.
- Firestore trip database with members, expenses, receipts, and settlement data.
- Web app buttons to pull/push/merge Firebase expenses and upload receipt photos.

### Firebase setup

1. Create a Firebase project and enable Firestore, Storage, and Cloud Functions.
2. Copy `.firebaserc.example` to `.firebaserc` and set your project id.
3. Copy `functions/.env.example` to `functions/.env` and fill:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_WEBHOOK_SECRET`
   - `RTBALI_LINK_CODE`
   - `RTBALI_SYNC_KEY`
   - optional `RTBALI_ALLOWED_CHAT_ID`
4. From `functions/`, run `npm install`.
5. From the repo root, run `firebase deploy`.
6. Set Telegram webhook:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "content-type: application/json" \
  -d '{"url":"https://REGION-PROJECT.cloudfunctions.net/telegramWebhook","secret_token":"YOUR_WEBHOOK_SECRET"}'
```

### Web sync setup

For local private use, copy `firebase-config.example.json` to
`firebase-config.json` and set:

- `apiBase`: your deployed `api` Cloud Function URL.
- `tripId`: normally `rtbali`.
- `syncKey`: same value as `RTBALI_SYNC_KEY`.

`firebase-config.json` is ignored by git so the shared sync key is not committed.

For GitHub Pages, do not commit `firebase-config.json`. Open the live app and use
**Cloud setup**. Paste:

- API URL: `https://asia-southeast2-rtbali.cloudfunctions.net/api`
- Trip ID: `rtbali`
- Sync key: the same value as `RTBALI_SYNC_KEY`

The app saves those values only in that browser's localStorage, so GitHub can host
the app without exposing the sync key in the repository.

After one device is configured, use **Copy setup link** and send that link to your
other devices. Opening the link saves the cloud config once, then the app removes
the secret from the address bar. Treat that link like a password.

When cloud setup exists, the dashboard automatically merges Telegram/Firebase
expenses on load and refreshes them about once per hour. Use **Merge expenses**
for an immediate manual refresh.

If the dashboard ever looks empty after **Pull cloud**, click **Reset** to reload
the built-in trip seed, then click **Merge expenses**. Pull now refuses to replace
the full dashboard when Firebase only contains expense rows.

### Telegram commands

In your Telegram group:

```text
/menu
/link YOUR_CODE TJ
/link YOUR_CODE EK
/link YOUR_CODE P3
/link YOUR_CODE P4
/unlink
/expense meal 220000 paid TJ split 50/50
/meal 220000 paid EK split order
/meal paid TJ split order tjfood 120000 ekfood 80000 shared 50000 tax 30000 place Warung Apple
/expense food paid EK split custom customtj 150000 customek 90000 vendor La Luna
/saldo
/who
```

`/menu` opens Telegram buttons for saldo, linked members, examples, OCR help,
and unlinking yourself from the trip.

Detailed expense keys match the web ledger: `date`, `place`, `vendor`,
`payment`, `desc`, `note`, `tjfood`, `ekfood`, `shared`, `tax`, `customtj`,
`customek`, and `notax`.

Send a receipt photo to create an OCR draft. If the bot does not respond in the
group, resend the photo with caption `/receipt`; this works when Telegram bot
privacy mode only forwards command messages. Confirm the latest draft with:

```text
/confirm
```

You can also confirm a specific OCR draft with `/confirm ocr-exp-...`.

When `firebase-config.json` exists, the web app also shows **OCR receipt**. Pick or
take a receipt photo, then the backend stores the image, runs OCR, creates a draft
expense, and merges it into the local ledger for review.

## GitHub layout

- `index.html` — GitHub Pages entry point.
- `RTBALI_command_center.html` — portable single-file app.
- `data/db.json` — git-tracked local database seed.
- `db.json` — root copy of the same seed for direct/manual use.
- `sw.js` and `manifest.webmanifest` — offline cache / install support.
- `functions/` — Firebase Cloud Functions Telegram bot and sync API.
- `firestore.rules`, `storage.rules` — backend security rules.
- `firebase-config.example.json` — example browser sync config.

## Data model (`db.json`)

`metadata`, `settings` (currency, TJ/EK split units, buffer rate), `lists`,
`tripPlans`, `accommodations`, `checklist`, `expenses`, `categoryDetails`
(the cost-plan source of truth), `categorySettings`, `restaurants`, `sources`.
