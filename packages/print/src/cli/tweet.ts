import { join } from "node:path";
import { composeTweetText } from "../social/tweet-text.js";
import { postTweet, type TwitterCredentials } from "../social/twitter.js";
import { loadPrint, printsDir } from "./load-inputs.js";

function credentialsFromEnv(): TwitterCredentials {
  const apiKey = process.env.X_API_KEY;
  const apiKeySecret = process.env.X_API_KEY_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessTokenSecret = process.env.X_ACCESS_TOKEN_SECRET;
  if (!apiKey || !apiKeySecret || !accessToken || !accessTokenSecret) {
    throw new Error(
      "Missing X/Twitter credentials — set X_API_KEY, X_API_KEY_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET.",
    );
  }
  return { apiKey, apiKeySecret, accessToken, accessTokenSecret };
}

const target = process.argv[2];
if (!target) {
  console.error("Usage: tweet <print-id>");
  process.exit(1);
}

const path = join(printsDir(), `${target}.json`);
const print = await loadPrint(path);
const text = composeTweetText(print);

console.log("Posting:\n" + text);
const credentials = credentialsFromEnv();
const posted = await postTweet(text, credentials);
console.log(`Posted: ${posted.url}`);
