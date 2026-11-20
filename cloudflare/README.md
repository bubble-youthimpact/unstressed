# Unstressed AI server (Cloudflare Worker)

This small server writes the replies for **Unstressed AI chat** and the **Reframe it** tool. It keeps
your OpenAI key private, only answers signed-in Unstressed users from your site, and never receives
anything when someone types crisis wording (the app shows crisis help instead).

Everything here is free on Cloudflare. OpenAI charges per use (about $0.0001 per chat reply or
reframe) from prepaid credit, so you can never be charged more than you load.

## 1. Get an OpenAI API key

1. Go to platform.openai.com → **Billing** and add prepaid credit (for example $5).
   ChatGPT Plus does not include API use.
2. **API keys → Create new secret key.** Copy it somewhere safe; it's shown once.

## 2. Create the Worker (no command line needed)

1. Sign up at dash.cloudflare.com (free).
2. **Workers & Pages → Create → Create Worker.** Name it `unstressed-reframe` and click **Deploy**.
3. Click **Edit code**, delete what's there, paste everything from `worker.js`, and click **Deploy**.
4. Go to the Worker's **Settings → Variables and Secrets** and add:

   | Type | Name | Value |
   | --- | --- | --- |
   | Secret | `OPENAI_API_KEY` | your OpenAI key |
   | Text | `FIREBASE_PROJECT_ID` | `halftime-79e0e` |
   | Text | `ALLOWED_ORIGINS` | your site, e.g. `https://yourname.github.io` (no slash at the end; separate several with commas) |

5. Recommended, the daily limits (60 chat replies and 30 reframes per person): **Storage & Databases → KV → Create** a namespace
   called `unstressed-limits`. Then in the Worker's **Settings → Bindings → Add → KV namespace**,
   set the variable name to `LIMITS` and pick `unstressed-limits`.
   Cloudflare's free plan allows 1,000 KV writes a day, which works out to about 1,000 chat replies
   and reframes a day across all users combined. Raise it later if you need to.

6. Copy the Worker's address from its overview page, for example
   `https://unstressed-reframe.yourname.workers.dev`.

## 3. Connect the app

In `firebase.js` (at the top of the website files), set your Worker's address, with no slash at the end:

```js
const AI_SERVER = "https://unstressed-reframe.yourname.workers.dev";
```

Upload `firebase.js` to GitHub. Chat and Reframe it now use real AI. If the address is empty or
the server can't be reached, chat uses its built-in replies and Reframe it shows a guided way to
reframe the thought yourself.

## Updating the Worker

When `worker.js` changes, open the Worker → **Edit code**, replace everything with the new
`worker.js`, and click **Deploy**. Your settings and key stay as they are.

## Prefer the command line?

Edit `wrangler.toml` (your site address, and the KV id if you create one), then:

```bash
npx wrangler login
npx wrangler secret put OPENAI_API_KEY
npx wrangler deploy
```

## Settings you can change in `worker.js`

- `MODEL`: the OpenAI model (`gpt-6-luna`, OpenAI's fast, low-cost model).
- `DAILY_LIMIT` and `CHAT_DAILY_LIMIT`: reframes and chat replies per person per day (only enforced with the `LIMITS` binding).
- `CHAT_RULES` (in the **EDIT HERE** box near the top): how Unstressed AI chats, one rule per line.
  Change wording, add or remove rules, then click **Deploy**. Keep the four `status` rules at the end.
- `OFF_TOPIC`, `DECLINED`, `SAFE_FALLBACK`: the fixed replies for off-topic messages, messages it
  won't answer, and AI replies that fail the safety check.
- `INSTRUCTIONS`: how the AI writes reframes.

## Chat safeguards

Every chat message goes through these steps:

1. **Crisis words** (the `RISK` list) never reach the AI. The app shows crisis help.
2. **OpenAI's moderation check** (free) reads the message first. Self-harm goes to crisis help.
   Sexual, hateful, drug and graphic violence content gets the fixed `DECLINED` reply, and the AI
   never sees it. If the check can't run, no AI is used and the app gives its built-in reply.
3. **The AI labels the message**: normal, off topic, declined or crisis. Only normal messages get an
   AI-written reply; the others get the fixed replies or crisis help.
4. **The AI's reply is checked** by moderation too. If anything is flagged, `SAFE_FALLBACK` is sent.
5. **Links, emails and phone numbers** (other than 988 and 911) are removed from replies.

To check what's happening, open the Worker → **Logs** (Observability) and send a chat message.
