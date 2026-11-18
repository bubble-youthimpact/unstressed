# Halftime: "Reframe it" AI server (Cloudflare Worker)

This small server writes the AI reframes for the **Reframe it** tool. It keeps your OpenAI key
private, only answers signed-in Halftime users, and never receives anything when someone types
crisis wording (the app shows crisis help instead).

Everything here is free on Cloudflare. OpenAI charges per use (about $0.0001 per reframe) from
prepaid credit, so you can never be charged more than you load.

## 1. Get an OpenAI API key

1. Go to platform.openai.com → **Billing** and add prepaid credit (for example $5).
   ChatGPT Plus does not include API use.
2. **API keys → Create new secret key.** Copy it somewhere safe; it's shown once.

## 2. Create the Worker (no command line needed)

1. Sign up at dash.cloudflare.com (free).
2. **Workers & Pages → Create → Create Worker.** Name it `halftime-reframe` and click **Deploy**.
3. Click **Edit code**, delete what's there, paste everything from `worker.js`, and click **Deploy**.
4. Go to the Worker's **Settings → Variables and Secrets** and add:

   | Type | Name | Value |
   | --- | --- | --- |
   | Secret | `OPENAI_API_KEY` | your OpenAI key |
   | Text | `FIREBASE_PROJECT_ID` | `halftime-79e0e` |
   | Text | `ALLOWED_ORIGINS` | your site, e.g. `https://yourname.github.io` (no slash at the end; separate several with commas) |

5. Recommended, the daily limit of 30 per person: **Storage & Databases → KV → Create** a namespace
   called `halftime-limits`. Then in the Worker's **Settings → Bindings → Add → KV namespace**,
   set the variable name to `LIMITS` and pick `halftime-limits`.
   Cloudflare's free plan allows 1,000 KV writes a day, which works out to about 1,000 reframes a
   day across all users. Raise it later if you need to.

6. Copy the Worker's address from its overview page, for example
   `https://halftime-reframe.yourname.workers.dev`.

## 3. Connect the app

In `firebase.js` (at the top of the website files), set:

```js
const REFRAME_URL = "https://halftime-reframe.yourname.workers.dev/reframe";
```

Upload `firebase.js` to GitHub. Reframe it now uses real AI. Until this is set, the tool shows a
guided way to reframe the thought yourself instead.

## Prefer the command line?

Edit `wrangler.toml` (your site address, and the KV id if you create one), then:

```bash
npx wrangler login
npx wrangler secret put OPENAI_API_KEY
npx wrangler deploy
```

## Settings you can change in `worker.js`

- `MODEL`: the OpenAI model (`gpt-6-luna`, OpenAI's fast, low-cost model).
- `DAILY_LIMIT`: reframes per person per day (only enforced with the `LIMITS` binding).
- `INSTRUCTIONS`: how the AI writes reframes.
