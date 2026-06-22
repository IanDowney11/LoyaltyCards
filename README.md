# Loyalty Cards

A PWA for storing and scanning loyalty card images. Syncs between your devices via NOSTR.

## Features

- Take a photo or upload an image of any loyalty card
- Tap a card to view it fullscreen — tap again to rotate for landscape barcodes
- Cards sorted alphabetically, stored locally in IndexedDB
- NOSTR sync: share a key with your partner so both phones see the same cards

## Sharing with your partner

1. Open **Settings** (gear icon) on your phone
2. Tap **Copy Key**
3. Send it to your partner
4. On their phone: open Settings → paste into **Import Key** → tap **Import & Sync**

Both devices now share the same card collection. Any cards added or deleted on either device will sync automatically.

## Local development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
# output is in dist/
```

## Deploy

Push to GitHub — Vercel auto-deploys on every push to `main`.
