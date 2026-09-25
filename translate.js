const crypto = require("crypto");

const ALLOWED = new Set([
  "en","am","ti","om","aa","so","es","ar","fr","de","zh"
]);

const MAX_CHARS = 5000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 30;

// Best-effort in-memory rate limiting for a single serverless instance.
// For production at scale, replace this Map with Redis/KV.
const buckets = globalThis.__lisanRateBuckets || new Map();
globalThis.__lisanRateBuckets = buckets;

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.end(JSON.stringify(body));
}

function getClientKey(req) {
  const device = String(req.headers["x-device-id"] || "").trim();
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || req.socket?.remoteAddress || "unknown";
  return device ? `device:${device.slice(0, 100)}` : `ip:${ip}`;
}

function checkRateLimit(key) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start >= RATE_WINDOW_MS) {
    b = { start: now, count: 0 };
    buckets.set(key, b);
  }
  b.count++;
  return {
    allowed: b.count <= RATE_LIMIT,
    remaining: Math.max(0, RATE_LIMIT - b.count),
    retryAfter: Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - b.start)) / 1000))
  };
}

function base64url(input) {
  return Buffer.from(input).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

let tokenCache = { token: null, expiresAt: 0 };

async function getGoogleAccessToken() {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.token;
  }

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!email || !privateKey) {
    throw new Error("Google service-account credentials are not configured.");
  }

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: email,
    scope: "https://www.googleapis.com/auth/cloud-translation",
    aud: "https://oauth2.googleapis.com/token",
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 3600
  }));

  const unsigned = `${header}.${payload}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();

  const signature = signer.sign(privateKey, "base64url");
  const assertion = `${unsigned}.${signature}`;

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

  const tokenData = await tokenResponse.json().catch(() => null);

  if (!tokenResponse.ok || !tokenData?.access_token) {
    console.error("Google token error:", tokenData);
    throw new Error("Could not authenticate with Google Cloud.");
  }

  tokenCache = {
    token: tokenData.access_token,
    expiresAt: now + Number(tokenData.expires_in || 3600) * 1000
  };

  return tokenCache.token;
}

async function googleTranslate({ source, target, text }) {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  if (!projectId) throw new Error("GOOGLE_CLOUD_PROJECT_ID is not configured.");

  const token = await getGoogleAccessToken();

  // Cloud Translation Advanced global endpoint.
  // Source language can be omitted for automatic detection.
  const body = {
    targetLanguageCode: target,
    contents: [text],
    mimeType: "text/plain"
  };

  if (source !== "auto") {
    body.sourceLanguageCode = source;
  }

  const url =
    `https://translation.googleapis.com/v3/projects/${encodeURIComponent(projectId)}` +
    `/locations/global:translateText`;

  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-goog-user-project": projectId
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const data = await response.json().catch(() => null);

      if (response.ok) {
        const item = data?.translations?.[0];
        if (!item?.translatedText) {
          throw new Error("Google returned no translated text.");
        }

        return {
          translation: item.translatedText,
          sourceLanguage: item.detectedLanguageCode || source
        };
      }

      const retryable = response.status === 429 || response.status >= 500;
      lastError = new Error(
        data?.error?.message || `Google Translation returned HTTP ${response.status}.`
      );

      if (!retryable) throw lastError;
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
    } finally {
      clearTimeout(timer);
    }

    await new Promise(r => setTimeout(r, 300 * 2 ** attempt));
  }

  throw lastError || new Error("Translation failed.");
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204)
      .setHeader("Access-Control-Allow-Origin", "*")
      .setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
      .setHeader("Access-Control-Allow-Headers", "Content-Type, X-Device-ID")
      .end();
    return;
  }

  // Same-origin requests from the supplied HTML do not need CORS,
  // but these headers also make separate frontend deployments possible.
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Device-ID");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed." });
  }

  const rate = checkRateLimit(getClientKey(req));
  res.setHeader("X-RateLimit-Remaining", String(rate.remaining));

  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfter));
    return json(res, 429, {
      error: "Too many translation requests. Please try again shortly."
    });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const source = String(body.source || "auto").trim().toLowerCase();
    const target = String(body.target || "").trim().toLowerCase();
    const text = String(body.text || "");

    if (source !== "auto" && !ALLOWED.has(source)) {
      return json(res, 400, { error: "Unsupported source language." });
    }

    if (!ALLOWED.has(target)) {
      return json(res, 400, { error: "Unsupported target language." });
    }

    if (!text.trim()) {
      return json(res, 400, { error: "Text is required." });
    }

    if (text.length > MAX_CHARS) {
      return json(res, 413, { error: `Text must be ${MAX_CHARS} characters or fewer.` });
    }

    if (source !== "auto" && source === target) {
      return json(res, 400, { error: "Source and target languages must be different." });
    }

    const result = await googleTranslate({
      source,
      target,
      text: text.trim()
    });

    return json(res, 200, {
      translation: result.translation,
      sourceLanguage: result.sourceLanguage || source,
      targetLanguage: target
    });
  } catch (error) {
    console.error("Translation API error:", error);

    const message = error?.message || "";
    const safe =
      message.includes("credentials") ||
      message.includes("configured")
        ? "Translation server is not configured correctly."
        : "Translation service is temporarily unavailable.";

    return json(res, 502, { error: safe });
  }
};
