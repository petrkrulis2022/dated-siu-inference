import { createHmac, randomBytes } from "node:crypto";

/**
 * OAuth 1.0a user-context posting for X's v2 API — the auth flow for posting as a specific
 * account (@touchstoneassay) rather than app-only read access, which is what the Bearer Token
 * gives. No new dependency: HMAC-SHA1 is one node:crypto call, RFC 3986 percent-encoding is a
 * small fixup over encodeURIComponent (which under-encodes !*'()).
 */

export interface TwitterCredentials {
  apiKey: string;
  apiKeySecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

const TWEETS_URL = "https://api.twitter.com/2/tweets";

/** encodeURIComponent leaves !*'() unescaped; RFC 3986 (and OAuth 1.0a) requires them escaped. */
function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Builds the OAuth 1.0a Authorization header for one signed request. `extraParams` covers
 * form-encoded body/query params when present — POST /2/tweets sends a JSON body, so it's empty
 * here, but the function stays general rather than assuming that of every caller.
 */
export function buildOAuth1Header(
  method: string,
  url: string,
  credentials: TwitterCredentials,
  extraParams: Record<string, string> = {},
  nonce: string = randomBytes(16).toString("hex"),
  timestamp: string = Math.floor(Date.now() / 1000).toString(),
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: credentials.accessToken,
    oauth_version: "1.0",
  };

  const allParams = { ...oauthParams, ...extraParams };
  const paramString = Object.keys(allParams)
    .sort()
    .map((key) => `${rfc3986Encode(key)}=${rfc3986Encode(allParams[key])}`)
    .join("&");

  const signatureBaseString = [method.toUpperCase(), rfc3986Encode(url), rfc3986Encode(paramString)].join("&");
  const signingKey = `${rfc3986Encode(credentials.apiKeySecret)}&${rfc3986Encode(credentials.accessTokenSecret)}`;
  const signature = createHmac("sha1", signingKey).update(signatureBaseString).digest("base64");

  const headerParams: Record<string, string> = { ...oauthParams, oauth_signature: signature };
  const headerString = Object.keys(headerParams)
    .sort()
    .map((key) => `${rfc3986Encode(key)}="${rfc3986Encode(headerParams[key])}"`)
    .join(", ");

  return `OAuth ${headerString}`;
}

export interface PostedTweet {
  id: string;
  url: string;
}

/** Posts one tweet as @touchstoneassay. Throws with the real API response body on failure —
 * never swallows an error, since a caller (the daily workflow) needs the real reason to log. */
export async function postTweet(text: string, credentials: TwitterCredentials): Promise<PostedTweet> {
  const authHeader = buildOAuth1Header("POST", TWEETS_URL, credentials);
  const res = await fetch(TWEETS_URL, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "content-type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  const body = (await res.json().catch(() => ({}))) as { data?: { id?: string }; errors?: unknown };
  if (!res.ok || !body.data?.id) {
    throw new Error(`Tweet failed: ${res.status} ${JSON.stringify(body)}`);
  }

  return { id: body.data.id, url: `https://x.com/touchstoneassay/status/${body.data.id}` };
}
