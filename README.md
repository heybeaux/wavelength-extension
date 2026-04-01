# Wavelength Chrome Extension

> **Personality-aware communication coaching for Gmail** — real-time suggestions that help you adapt your message style to your recipient's communication preferences.

![Wavelength Extension](https://mywavelength.ai/og-image.png)

---

## What It Does

Wavelength analyzes your Gmail drafts and gives you live coaching suggestions based on your recipient's DISC communication profile. Write in a style that actually resonates — more direct with Drivers, more context with Conscientious types, warmer with Influencers.

- 🎯 **Live coaching** — suggestions appear as you type in Gmail compose
- 🔁 **One-click rewrites** — apply a suggestion instantly
- ✉️ **Subject line suggestions** — smarter subject lines, not just body copy
- 🔐 **Auth via your Wavelength account** — no separate login needed

---

## Chrome Web Store

The extension is currently under review. Once approved, you'll be able to install it directly from the Chrome Web Store.

**In the meantime, you can load it manually in under 2 minutes — instructions below.**

---

## Load Unpacked (Developer Mode)

This lets you install the extension directly from source without waiting for store approval.

### Step 1 — Download the source

**Option A: Download ZIP**
1. Click the green **Code** button at the top of this page
2. Select **Download ZIP**
3. Unzip the file somewhere you'll remember (e.g. `~/Downloads/wavelength-extension`)

**Option B: Clone with Git**
```bash
git clone https://github.com/beaux-riel/wavelength-extension.git
```

### Step 2 — Open Chrome Extensions

1. Open Chrome and go to: `chrome://extensions`
2. Toggle **Developer mode** on (top-right corner)

### Step 3 — Load the extension

1. Click **Load unpacked**
2. Select the folder you downloaded/cloned in Step 1
   - If you downloaded the ZIP, select the unzipped folder (the one containing `manifest.json`)
3. The Wavelength extension should appear in your extensions list

### Step 4 — Pin it (optional but recommended)

1. Click the puzzle piece icon (🧩) in the Chrome toolbar
2. Find **Wavelength — Communication Coach**
3. Click the pin icon to keep it visible

### Step 5 — Sign in

1. Click the Wavelength icon in your toolbar
2. Click **Sign In** — you'll be redirected to [mywavelength.ai](https://mywavelength.ai) to authenticate
3. Once signed in, open Gmail and start composing

---

## Requirements

- Google Chrome (version 88+)
- A [Wavelength account](https://mywavelength.ai) — free to sign up
- Gmail (web) — `mail.google.com`

---

## Keeping It Updated

When developer mode extensions update (e.g. new version pushed here), Chrome won't auto-update them. To get the latest:

- **If you cloned:** run `git pull` in the extension folder, then go to `chrome://extensions` and click the refresh icon on the Wavelength card
- **If you downloaded ZIP:** re-download and re-load unpacked

We'll notify users via the dashboard when a new version is available.

---

## Privacy

- The extension reads Gmail compose windows to provide coaching
- No email content is stored — suggestions are generated in real-time and discarded
- Authentication tokens are stored locally in Chrome's `storage.local` (never sent to third parties)
- Full privacy policy: [mywavelength.ai/privacy](https://mywavelength.ai/privacy)

---

## Feedback & Issues

Found a bug or have a feature request? [Open an issue](https://github.com/beaux-riel/wavelength-extension/issues) or reach out at [hello@mywavelength.ai](mailto:hello@mywavelength.ai).

---

## Built With

- Chrome Extension Manifest V3
- Vanilla JS (no build step required — load directly from source)
- [Wavelength API](https://api-production-dad4.up.railway.app) — NestJS backend

---

*Part of [Wavelength](https://mywavelength.ai) — communication coaching for high-performing teams.*
