/**
 * OAuth 2.0 authentication for YouTube Data API.
 *
 * Two-phase auth flow for Telegram/chat:
 *   Phase 1: No token → generate auth URL, throw AuthRequiredError
 *            (the agent shows the URL to the user in chat)
 *   Phase 2: User pastes the redirect URL → youtube_auth tool extracts code,
 *            exchanges for token, saves it
 *
 * Supports two token formats:
 *   - Native format: { access_token, refresh_token, token_type, expiry_date }
 *   - Python bot format: { token, refresh_token, client_id, client_secret, expiry }
 */

import { google } from "googleapis";
import type { youtube_v3 } from "googleapis";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

const SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"];
const REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

interface StoredToken {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expiry_date: number;
  scope?: string;
}

/** Python bot token format (from google-auth Credentials.to_json()) */
interface PythonToken {
  token?: string;
  refresh_token?: string;
  client_id?: string;
  client_secret?: string;
  expiry?: string;
  scopes?: string[];
}

interface OAuthClientSecrets {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris?: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris?: string[];
  };
}

/**
 * Custom error thrown when OAuth is needed.
 * Contains the auth URL for the agent to show to the user.
 */
export class AuthRequiredError extends Error {
  public readonly authUrl: string;

  constructor(authUrl: string) {
    super(
      `YouTube OAuth authorization required.\n\n` +
        `Open this link and sign in with the YouTube channel account:\n${authUrl}\n\n` +
        `After authorizing, Google will show you a code. ` +
        `Copy that code and paste it here.`,
    );
    this.name = "AuthRequiredError";
    this.authUrl = authUrl;
  }
}

/** Load and parse client secrets file */
export function loadClientSecrets(
  credentialsPath: string,
): { clientId: string; clientSecret: string } {
  if (!existsSync(credentialsPath)) {
    throw new Error(
      `OAuth credentials file not found at: ${credentialsPath}\n` +
        "Download client_secret.json from Google Cloud Console.\n" +
        "See README.md for instructions.",
    );
  }

  const secretsRaw = JSON.parse(
    require("node:fs").readFileSync(credentialsPath, "utf-8"),
  ) as OAuthClientSecrets;
  const secrets = secretsRaw.installed ?? secretsRaw.web;
  if (!secrets) {
    throw new Error("Invalid client_secret.json: missing 'installed' or 'web' key");
  }

  return { clientId: secrets.client_id, clientSecret: secrets.client_secret };
}

/**
 * Build an authenticated YouTube Data API v3 service.
 *
 * - If token exists, loads and refreshes if needed
 * - If no token exists, throws AuthRequiredError with the auth URL
 *   (the calling tool catches this and returns the URL to the user)
 */
export async function getYouTubeService(
  credentialsPath: string,
  tokenPath: string,
  logger?: { info: (msg: string) => void; error: (msg: string) => void },
): Promise<youtube_v3.Youtube> {
  const log = logger ?? { info: console.log, error: console.error };
  const { clientId, clientSecret } = loadClientSecrets(credentialsPath);

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  // Try to load existing token
  if (existsSync(tokenPath)) {
    const raw = JSON.parse(await readFile(tokenPath, "utf-8"));
    const tokenData = normalizeToken(raw);

    oauth2Client.setCredentials({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      token_type: tokenData.token_type,
      expiry_date: tokenData.expiry_date,
    });

    // Check if token needs refresh
    const tokenInfo = oauth2Client.credentials;
    const isExpired = tokenInfo.expiry_date != null && tokenInfo.expiry_date < Date.now();

    if (isExpired && tokenInfo.refresh_token) {
      log.info("Refreshing expired OAuth token...");
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);
      await saveToken(tokenPath, credentials as unknown as Record<string, unknown>);
      log.info("OAuth token refreshed successfully");
    }

    return google.youtube({ version: "v3", auth: oauth2Client });
  }

  // No token — generate auth URL and throw so the agent can show it
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  throw new AuthRequiredError(authUrl);
}

/**
 * Complete OAuth: exchange an authorization code for tokens.
 * Called by the youtube_auth tool after the user pastes the code.
 */
export async function completeOAuth(
  credentialsPath: string,
  tokenPath: string,
  code: string,
  logger?: { info: (msg: string) => void; error: (msg: string) => void },
): Promise<youtube_v3.Youtube> {
  const log = logger ?? { info: console.log, error: console.error };
  const { clientId, clientSecret } = loadClientSecrets(credentialsPath);

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  log.info("Exchanging authorization code for token...");
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  await saveToken(tokenPath, tokens as unknown as Record<string, unknown>);
  log.info("OAuth authentication successful!");

  return google.youtube({ version: "v3", auth: oauth2Client });
}

/**
 * Normalize token from either native or Python bot format.
 */
function normalizeToken(raw: Record<string, unknown>): StoredToken {
  // Check if it's Python format (has "token" key instead of "access_token")
  if ("token" in raw && !("access_token" in raw)) {
    const pyToken = raw as unknown as PythonToken;
    let expiryDate = 0;
    if (pyToken.expiry) {
      expiryDate = new Date(pyToken.expiry).getTime();
    }
    return {
      access_token: pyToken.token ?? "",
      refresh_token: pyToken.refresh_token ?? "",
      token_type: "Bearer",
      expiry_date: expiryDate,
    };
  }

  // Native format
  return {
    access_token: (raw.access_token as string) ?? "",
    refresh_token: (raw.refresh_token as string) ?? "",
    token_type: (raw.token_type as string) ?? "Bearer",
    expiry_date: (raw.expiry_date as number) ?? 0,
  };
}

/** Save OAuth token to disk */
async function saveToken(
  tokenPath: string,
  credentials: Record<string, unknown>,
): Promise<void> {
  const dir = dirname(tokenPath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  const tokenData: StoredToken = {
    access_token: (credentials.access_token as string) ?? "",
    refresh_token: (credentials.refresh_token as string) ?? "",
    token_type: (credentials.token_type as string) ?? "Bearer",
    expiry_date: (credentials.expiry_date as number) ?? 0,
  };
  await writeFile(tokenPath, JSON.stringify(tokenData, null, 2), "utf-8");
}

/**
 * Get the channel ID of the authenticated OAuth user.
 * Port of main.py:119-129 (get_authenticated_channel_id).
 */
export async function getAuthenticatedChannelId(
  youtube: youtube_v3.Youtube,
): Promise<string | null> {
  try {
    const response = await youtube.channels.list({
      part: ["id", "snippet"],
      mine: true,
    });
    const items = response.data.items ?? [];
    if (items.length > 0) {
      return items[0].id ?? null;
    }
  } catch (err) {
    // Logged by caller
  }
  return null;
}
