# Lexiflow IELTS

Desktop vocabulary app built with Electron + React + Vite.

## Prerequisites

- Node.js 20+

## Setup

1. `npm install`
2. Copy `.env.example` to `.env.local` and set `GEMINI_API_KEY` (optional; needed for AI word generation)

## Develop (desktop window)

```bash
npm run dev
```

Opens Lexiflow in an Electron window automatically — you do **not** need a browser.

> Web-only preview (browser): `npm run dev:web`

## Build portable Windows app

```bash
npm run dist
```

Output:

```
release/Lexiflow-IELTS-1.0.0-portable.exe
```

Run that `.exe` directly — no install required.

## Other scripts

| Script | What it does |
|--------|----------------|
| `npm start` | Launch Electron against an existing `dist/` build |
| `npm run build` | Vite web bundle only (no packaging) |
| `npm run clean` | Delete `dist/` and `release/` |
