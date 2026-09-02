<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/e395d4bd-79d3-4835-8c40-eb034a3693ec

## Run Locally

**Prerequisites:** Node.js


1. Install dependencies:
   `npm install`
2. For Cloudflare Worker local dev, create `.dev.vars` with your local secrets:
   `GEMINI_API_KEY=...`
   `FIREBASE_SERVICE_ACCOUNT_JSON=...`
   `FIREBASE_PROJECT_ID=...`
3. Run the Worker locally:
   `npm run dev`

## Cloudflare Workers Deployment

This project is configured to deploy as a Cloudflare Worker with static SPA assets.

1. Install dependencies:
   `npm install`
2. Build the frontend assets:
   `npm run build`
3. Add Worker secrets using Wrangler:
   `npx wrangler secret put GEMINI_API_KEY`
   `npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON`
   `npx wrangler secret put FIREBASE_PROJECT_ID`
4. Generate Worker binding types after config changes:
   `npm run types:worker`
5. Start local Worker dev:
   `npm run dev`
6. Deploy:
   `npm run deploy`

Notes:
- Use `.dev.vars` for local Worker-only secrets. It is gitignored.
- `.env` files remain local-only and are gitignored.
