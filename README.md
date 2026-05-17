# Recruno Automated Leads

Local-first proof-of-work app for turning a client hiring brief into a recruiter-ready LinkedIn candidate sheet with evidence, fit scoring, intent scoring, manual review, Apollo enrichment, and exports.

## What It Demonstrates

The workflow is:

1. Settings and API key setup
2. JD / client brief input
3. Smart expansion of human-language filters
4. OpenAI / ChatGPT query matrix generation
5. Query review, editing, selection, and configurable pagination
6. SerpAPI Google execution
7. LinkedIn URL normalization and deduplication
8. Apify profile extraction using `harvestapi/linkedin-profile-scraper`
9. OpenAI / ChatGPT fit + intent analysis
10. Manual recruiter review
11. Apollo-only contact enrichment
12. CSV, XLSX, and JSON recruiter sheet export

There is also a **One Click** mode in the sidebar. It is a separate fast lane:

1. Paste or upload JD text
2. Click **Start One Click**
3. The app generates queries, runs SerpAPI, cleans/dedupes profile URLs, scrapes profiles with Apify, and scores fit + intent
4. It stops before Apollo
5. Download the scored shortlist as CSV, XLSX, or JSON

One Click mode keeps its results separate from the normal step-by-step wizard state.

No Hunter integration is included. Lusha is not implemented; it is mentioned only as a possible future fallback.

## Setup

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:4000
```

PowerShell on this machine may block `npm.ps1`; if so, use:

```bash
cmd /c npm install
cmd /c npm run dev
```

## Deploying To Vercel

This repo is ready to deploy as a standard Next.js app.

Recommended Vercel settings:

- Framework preset: Next.js
- Build command: `npm run build`
- Install command: `npm install`
- Output directory: leave blank
- Node.js: Vercel default is fine

Add these environment variables in Vercel Project Settings:

```env
OPENAI_API_KEY=
SERPAPI_API_KEY=
APIFY_API_TOKEN=
APIFY_ACTOR_ID=harvestapi/linkedin-profile-scraper
APOLLO_API_KEY=
```

For now, Apollo can be left blank if you are pausing contact enrichment.

Important deployment note: this prototype uses local JSON files for workflow state. On Vercel, that state is stored in serverless temporary storage and can reset between deployments or function cold starts. Use Vercel env vars for API keys. If you need shared persistent workflow history in production, add durable storage later.

## Can This Run On GitHub Pages?

Not as-is.

GitHub Pages only hosts static files. Recruno Automated Leads needs Next.js API routes for:

- server-side API key handling
- OpenAI scoring
- SerpAPI searches
- Apify actor runs
- Apollo enrichment
- CSV/XLSX/JSON exports
- local workflow state

So the practical setup is:

1. Push this repo to GitHub.
2. Import the GitHub repo into Vercel.
3. Add the environment variables in Vercel.
4. Deploy the website from Vercel.

GitHub is still useful as the source repo. Vercel is what runs the app as a website.

## API Keys

Copy `.env.example` to `.env.local` or enter keys from the Settings page.

```env
OPENAI_API_KEY=
SERPAPI_API_KEY=
APIFY_API_TOKEN=
APIFY_ACTOR_ID=harvestapi/linkedin-profile-scraper
APOLLO_API_KEY=
```

The Settings page stores keys locally in `data/settings.json` on a laptop. On Vercel, use Project Environment Variables instead. Production must use secure secret storage, access controls, encryption, audit logging, and server-only runtime secrets.

## Real API Mode

The app now runs against real APIs only. If a required key is missing, the relevant step shows an error instead of generating sample data.

All external calls happen in server routes; API keys are not returned to the browser.

## Persistence

The app stores workflow state in local JSON files under `data/`:

- `data/settings.json`
- `data/state.json`

Intermediate data is preserved after each step, including raw SerpAPI page snapshots and raw Apify/Apollo payloads.

Use **Reset data** in the top menu to clear local workflow state.

## Apify Actor

Default actor:

```text
harvestapi/linkedin-profile-scraper
```

The default actor payload is:

```json
{
  "profileScraperMode": "Profile details no email ($4 per 1k)",
  "queries": ["https://www.linkedin.com/in/example"]
}
```

The actor ID remains configurable in Settings. The app also accepts the Apify actor ID `LpVuK3Zozwuipa5bp`.

## LinkedIn Posts vs Profiles

The final recruiter sheet only uses `linkedin.com/in/...` profile URLs as candidate links.

`linkedin.com/posts/...` results are stored as intent evidence sources. They are never used as the main candidate LinkedIn URL. If a post result cannot be connected to a visible author profile, it is marked `author_profile_missing` and remains a manual-review evidence item.

## Apollo Credits

Before enrichment, the app estimates:

- Email: 1 Apollo credit
- Phone: 8 Apollo credits approx

Only manually approved candidates with enrichment enabled are sent to Apollo.

## Exports

Final recruiter sheet exports are available as:

- CSV
- XLSX
- JSON

Columns include candidate identity, LinkedIn URL, current/past experience, visibility factor, matched queries, fit and intent scores, tier, evidence, intent signals, Apollo contact status, manual notes, and outreach angle.

The Review step also has scored shortlist download buttons for CSV, XLSX, and JSON. This is useful while Apollo is paused.

## Cost Controls

The scoring step is intentionally capped by default. It scores scraped or partially scraped profiles first, sorted by visibility factor, with a default cap of 50 candidates. Increase the cap in the UI only when you want broader OpenAI scoring coverage.

One Click mode has its own **Max profiles to score** setting for the same reason.

Tier thresholds are:

- Tier 1: total score above 80
- Tier 2: 60 to 80
- Tier 3: 30 to 60
- Tier 4: below 30
