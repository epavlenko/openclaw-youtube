/**
 * OAuth 2.0 authentication for YouTube Data API.
 *
 * Port of main.py:91-116 (get_youtube_service).
 * Uses googleapis npm package instead of google-auth-oauthlib.
 *
 * Supports two token formats:
 *   - Native format: { access_token, refresh_token, token_type, expiry_date }
 *   - Python bot format: { token, refresh_token, client_id, client_secret, expiry }
 *
 * Headless server support:
 *   - Listens on 0.0.0.0 (not just localhost) so SSH port-forwarding works
 *   - Prints clear instructions for manual auth via SSH tunnel
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
 * Build an authenticated YouTube Data API v3 service.
 *
 * - Loads OAuth token from tokenPath if it exists (supports both native and Python formats)
 * - Refreshes expired tokens automatically
 * - If no token exists, runs a local OAuth flow with headless-friendly instructions
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
    "http://localhost:8090",
  );

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
  } else {
    // No token -- run OAuth flow
    log.info("No OAuth token found, starting authentication flow...");
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      prompt: "consent",
    });

    const code = await getAuthCodeViaLocalServer(authUrl, 8090, log);
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    await saveToken(tokenPath, tokens as unknown as Record<string, unknown>);
    log.info("OAuth authentication successful!");
  }

  return google.youtube({ version: "v3", auth: oauth2Client });
}

/**
 * Normalize token from either native or Python bot format.
 *
 * Python bot (google-auth) saves:
 *   { token, refresh_token, client_id, client_secret, expiry: "2026-02-13T..." }
 *
 * Our native format:
 *   { access_token, refresh_token, token_type, expiry_date: 1739... }
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

/**
 * Run a local HTTP server to receive the OAuth callback.
 *
 * Binds to 0.0.0.0 so SSH port-forwarding works on headless servers.
 * Prints clear instructions for both local and remote auth.
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

    // Listen on 0.0.0.0 so SSH tunneling works
    server.listen(port, "0.0.0.0", () => {
      logger.info(
        `\n` +
          `═══════════════════════════════════════════════════════\n` +
          `  YouTube OAuth Authentication Required\n` +
          `═══════════════════════════════════════════════════════\n` +
          `\n` +
          `  On a headless server? Run this on your LOCAL machine:\n` +
          `\n` +
          `    ssh -L 8090:localhost:8090 root@<your-server>\n` +
          `\n` +
          `  Then open this URL in your browser:\n` +
          `\n` +
          `  ${authUrl}\n` +
          `\n` +
          `  Waiting for authentication (10 min timeout)...\n` +
          `═══════════════════════════════════════════════════════`,
      );

      // Try to open in browser (will silently fail on headless)
      import("node:child_process")
        .then(({ exec }) => {
          const cmd =
            process.platform === "darwin"
              ? `open "${authUrl}"`
              : process.platform === "win32"
                ? `start "${authUrl}"`
                : `xdg-open "${authUrl}" 2>/dev/null`;
          exec(cmd).unref?.();
        })
        .catch(() => {});
    });

    // Timeout after 10 minutes (was 5, increased for headless setup)
    setTimeout(() => {
      server.close();
      reject(
        new Error(
          "OAuth authentication timed out (10 minutes).\n" +
            "Tip: you can copy an existing token.json from the Python bot:\n" +
            "  scp local-machine:path/to/token.json server:~/.openclaw/data/openclaw-youtube/token.json",
        ),
      );
    }, 10 * 60 * 1000);
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
