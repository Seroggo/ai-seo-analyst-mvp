# AI SEO Analyst Frontend

Minimal Vite + React frontend for AI SEO Analyst demo MVP.

The app calls the Supabase Edge Function `summary-report` and displays a Markdown SEO report.

## Local frontend run

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev
npm run build
```

On Windows PowerShell, use this instead of `cp`:

```powershell
Copy-Item .env.example .env.local
```

Before running the app, fill `VITE_DEMO_TOKEN` in `.env.local`.

Do not commit `.env.local`.

## Required environment variables

```env
VITE_SUPABASE_FUNCTION_URL=https://zrbujphgaxhofqmmbqhv.supabase.co/functions/v1/summary-report
VITE_DEMO_TOKEN=replace-with-demo-token
```

## Vercel settings

Use these settings when importing the repository into Vercel:

```text
Root Directory: frontend
Framework Preset: Vite
Install Command: npm install
Build Command: npm run build
Output Directory: dist
```

Add these environment variables in Vercel:

```text
VITE_SUPABASE_FUNCTION_URL
VITE_DEMO_TOKEN
```

Do not add TopVisor API key or OpenModel API key to the frontend or Vercel frontend environment.
