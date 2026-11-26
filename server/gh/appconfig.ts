// server/gh/appconfig.ts — the switch of the ChoiBot GitHub app login (PR 1 of the GitHub app
// plan). OFF by default: a deploy changes no console's GitHub login. On only with both keys:
//   GITHUB_APP_LOGIN=1          the console's own gh and git calls use the app's token when it
//                               has one (server/gh/handoff.ts), and the routes of
//                               server/gh/appapi.ts answer
//   GITHUB_APP_CLIENT_ID=<id>   the app's client id: a public value, never a secret
//   GITHUB_APP_URL=<link>       the app's public page, https://github.com/apps/<name> (optional:
//                               the Set-up page links to it, to install the app on repos)
// The agents' own gh login is not touched here (the move is a later, separate step).

// GitHub prints the client id on the app's settings page. Its exact form is not in the docs:
// letters, digits, ".", "_" and "-" only, so it is safe in a form body.
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{4,100}$/;

// The app's public page on GitHub, and nothing else.
const APP_URL_RE = /^https:\/\/github\.com\/apps\/[a-z0-9][a-z0-9-]{0,33}$/i;

export type GithubAppConfig = { clientId: string; appUrl: string | null };

export function githubAppConfig(env: Record<string, string | undefined> = process.env): GithubAppConfig | null {
  if ((env.GITHUB_APP_LOGIN ?? "").trim() !== "1") return null;
  const clientId = (env.GITHUB_APP_CLIENT_ID ?? "").trim();
  if (!CLIENT_ID_RE.test(clientId)) return null;
  const url = (env.GITHUB_APP_URL ?? "").trim().replace(/\/+$/, "");
  return { clientId, appUrl: APP_URL_RE.test(url) ? url : null };
}
