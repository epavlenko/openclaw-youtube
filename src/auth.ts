/**
 * OAuth 2.0 authentication for YouTube Data API.
 *
 * Port of main.py:91-116 (get_youtube_service).
 * Uses googleapis npm package instead of google-auth-oauthlib.
 */

import { google } from "googleapis";
import type { youtube_v3 } from "googleapis";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

const SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"];

interface StoredToken {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expiry_date: number;
  scope?: string;
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
 * Build an authenticated YouTube Data API v3 service.
 *
 * - Loads OAuth token from tokenPath if it exists
 * - Refreshes expired tokens automatically
 * - If no token exists, runs a local OAuth flow (opens browser)
 * - Saves the token after successful auth
 */
export async function getYouTubeService(
  credentialsPath: string,
  tokenPath: string,
  logger?: { info: (msg: string) => void; error: (msg: string) => void },
): Promise<youtube_v3.Youtube> {
  const log = logger ?? { info: console.log, error: console.error };

  // Load client secrets
  if (!existsSync(credentialsPath)) {
    throw new Error(
      `OAuth credentials file not found at: ${credentialsPath}\n` +
        "Download client_secret.json from Google Cloud Console.\n" +
        "See README.md for instructions.",
    );
  }

  const secretsRaw = JSON.parse(await readFile(credentialsPath, "utf-8")) as OAuthClientSecrets;
  const secrets = secretsRaw.installed ?? secretsRaw.web;
  if (!secrets) {
    throw new Error("Invalid client_secret.json: missing 'installed' or 'web' key");
  }

  const oauth2Client = new google.auth.OAuth2(
    secrets.client_id,
    secrets.client_secret,
    secrets.redirect_uris?.[0] ?? "http://localhost:8090",
  );

  // Try to load existing token
  if (existsSync(tokenPath)) {
    const tokenData = JSON.parse(await readFile(tokenPath, "utf-8")) as StoredToken;
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
  } else {
    // No token -- run OAuth flow
    log.info("No OAuth token found, starting authentication flow...");
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      prompt: "consent",
    });

    // For OpenClaw plugin context, we use a local server callback
    // This mirrors the Python InstalledAppFlow.run_local_server(port=8090)
    const code = await getAuthCodeViaLocalServer(authUrl, 8090, log);
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    await saveToken(tokenPath, tokens as unknown as Record<string, unknown>);
    log.info("OAuth authentication successful!");
  }

  return google.youtube({ version: "v3", auth: oauth2Client });
}

/**
 * Run a minimal local HTTP server to receive the OAuth callback.
 * Opens the auth URL in the user's browser and waits for the redirect.
 */
async function getAuthCodeViaLocalServer(
  authUrl: string,
  port: number,
  logger: { info: (msg: string) => void },
): Promise<string> {
  const { createServer } = await import("node:http");
  const { URL } = await import("node:url");

  return new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://localhost:${port}`);
        const code = url.searchParams.get("code");
        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<html><body><h2>Authentication successful!</h2>" +
              "<p>You can close this tab and return to OpenClaw.</p></body></html>",
          );
          server.close();
          resolve(code);
        } else {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing authorization code");
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal error");
        server.close();
        reject(err);
      }
    });

    server.listen(port, () => {
      logger.info(`Open this URL to authenticate:\n${authUrl}`);
      // Try to open in browser
      import("node:child_process").then(({ exec }) => {
        const cmd =
          process.platform === "darwin"
            ? `open "${authUrl}"`
            : process.platform === "win32"
              ? `start "${authUrl}"`
              : `xdg-open "${authUrl}"`;
        exec(cmd).unref?.();
      });
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth authentication timed out (5 minutes)"));
    }, 5 * 60 * 1000);
  });
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
