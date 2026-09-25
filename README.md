# Lisan Translate API

This backend matches the frontend's `POST /api/translate` request:

```json
{
  "source": "en",
  "target": "am",
  "text": "Hello"
}
```

Response:

```json
{
  "translation": "ሰላም",
  "sourceLanguage": "en",
  "targetLanguage": "am"
}
```

## 1. Google Cloud setup

Create/select a Google Cloud project, enable Cloud Translation API, create a service account, and give that service account permission to use Cloud Translation. Cloud Translation Advanced uses the `projects/{PROJECT_ID}/locations/global:translateText` REST endpoint and accepts `sourceLanguageCode`, `targetLanguageCode`, and `contents`. Source language can be omitted for automatic detection.

## 2. Environment variables

Copy `.env.example` to your deployment's environment-variable settings:

- `GOOGLE_CLOUD_PROJECT_ID`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`
- `ALLOWED_ORIGIN`

Never put these values into the HTML, JavaScript frontend, Git repository, or public files.

## 3. Deploy with Vercel

Install Vercel CLI if needed:

```bash
npm install -g vercel
```

From this folder:

```bash
vercel
```

Add the environment variables in Vercel Project Settings, then redeploy.

The frontend can then call:

```text
POST /api/translate
```

## 4. Local test

Run:

```bash
vercel dev
```

Then open the local URL and use the supplied Lisan Translate HTML.

## Security

The endpoint validates language codes, limits input to 5,000 characters, uses server-side Google credentials, has timeout/retry handling, and includes a best-effort per-instance rate limiter. For a high-traffic production deployment, replace the in-memory rate limiter with persistent Redis/KV storage.
