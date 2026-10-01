/**
 * GitHub App creation via the App Manifest flow (for `setup:infra`).
 *
 * Unlike OAuth Apps (no creation API — credentials must be copied from the UI), a GitHub App can
 * be created programmatically: we serve a tiny local page that POSTs an app manifest to GitHub,
 * the user clicks "Create GitHub App" once (the only manual moment — GitHub requires a logged-in
 * human to approve), GitHub redirects back to our local server with a temporary `code`, and we
 * exchange it at `POST /app-manifests/{code}/conversions` for the app's `client_id` +
 * `client_secret`. A GitHub App's client_id/secret drive the same "Sign in with GitHub" OAuth flow
 * clinozy-be already uses, so nothing in the backend changes.
 *
 * SECRETS: the returned client secret is handled by the caller (written to `.env.<environment>`),
 * never printed. See SETUP_INFRA_PROVIDER_TEMPLATE.md.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as logger from '@setup/common/logger.js';
import { setupFetch } from '@setup/common/setup-fetch.js';

/** Inputs for the manifest: app name, homepage URL, and the per-env OAuth callback URLs. */
export interface GithubAppManifestInput {
  name: string;
  homepageUrl: string;
  callbackUrls: string[];
  /** When set, create the app under this organization instead of the personal account. */
  organization?: string;
  /** How long to wait for the browser approval before giving up (default 5 min). */
  timeoutMs?: number;
}

/** The credentials returned by the manifest conversion. */
export interface GithubAppCredentials {
  clientId: string;
  clientSecret: string;
  slug: string;
  htmlUrl: string;
}

/** Open a URL in the default browser (best-effort; the caller also prints it). No shell. */
function openBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  spawnSync(command, args, { stdio: 'ignore' });
}

/**
 * Run the GitHub App Manifest flow end to end and return the created app's credentials.
 *
 * @remarks
 * **Algorithm:** spins up a localhost HTTP server; `/` auto-submits the manifest form to GitHub;
 * `/callback` receives `?code=&state=`, verifies the state nonce, and POSTs to the conversions
 * endpoint. **Failure modes:** rejects on state mismatch, conversions non-2xx, or timeout.
 * **Side effects:** binds an ephemeral local port, opens a browser, one outbound POST to GitHub.
 */
export function createGithubAppViaManifest(
  input: GithubAppManifestInput,
): Promise<GithubAppCredentials> {
  const state = randomBytes(16).toString('hex');
  const timeoutMs = input.timeoutMs ?? 300_000;

  return new Promise<GithubAppCredentials>((resolve, reject) => {
    const server = createHttpServer((request, response) => {
      const port = (server.address() as AddressInfo).port;
      const requestUrl = new URL(request.url ?? '/', `http://localhost:${port}`);

      if (requestUrl.pathname === '/') {
        const manifest = JSON.stringify({
          name: input.name,
          url: input.homepageUrl,
          redirect_url: `http://localhost:${port}/callback`,
          callback_urls: input.callbackUrls,
          public: true,
          default_permissions: { emails: 'read' },
          default_events: [],
          request_oauth_on_install: false,
        });
        const action = input.organization
          ? `https://github.com/organizations/${input.organization}/settings/apps/new?state=${state}`
          : `https://github.com/settings/apps/new?state=${state}`;
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(
          `<!doctype html><html><body onload="document.forms[0].submit()">` +
            `<form method="post" action="${action}">` +
            `<input type="hidden" name="manifest" value='${manifest.replace(/'/g, '&#39;')}'>` +
            `<noscript><button type="submit">Create GitHub App</button></noscript>` +
            `</form></body></html>`,
        );
        return;
      }

      if (requestUrl.pathname === '/callback') {
        const code = requestUrl.searchParams.get('code');
        const returnedState = requestUrl.searchParams.get('state');
        if (returnedState !== state || !code) {
          response.writeHead(400, { 'Content-Type': 'text/html' });
          response.end('<p>Invalid state or missing code — close this tab and re-run setup.</p>');
          return;
        }
        setupFetch({
          name: 'GitHub',
          url: `https://api.github.com/app-manifests/${code}/conversions`,
          init: {
            method: 'POST',
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'clinozy-be-setup' },
          },
        })
          .then(async (conversion) => {
            if (!conversion.ok) {
              throw new Error(
                `GitHub manifest conversion failed (${conversion.status}): ${await conversion.text()}`,
              );
            }
            const body = (await conversion.json()) as {
              client_id?: string;
              client_secret?: string;
              slug?: string;
              html_url?: string;
            };
            if (!(body.client_id && body.client_secret)) {
              throw new Error('GitHub returned no client_id/client_secret for the app.');
            }
            response.writeHead(200, { 'Content-Type': 'text/html' });
            response.end('<p>GitHub App created — return to your terminal.</p>');
            server.close();
            resolve({
              clientId: body.client_id,
              clientSecret: body.client_secret,
              slug: body.slug ?? input.name,
              htmlUrl: body.html_url ?? '',
            });
          })
          .catch((error: unknown) => {
            response.writeHead(500, { 'Content-Type': 'text/html' });
            response.end('<p>App conversion failed — see your terminal.</p>');
            server.close();
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        return;
      }

      response.writeHead(404);
      response.end();
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for the GitHub App to be created in the browser.'));
    }, timeoutMs);
    server.on('close', () => clearTimeout(timer));
    server.on('error', (error) => reject(error));

    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      const url = `http://localhost:${port}/`;
      logger.info(`Opening ${url} → click "Create GitHub App" in the browser (one step).`);
      openBrowser(url);
    });
  });
}
