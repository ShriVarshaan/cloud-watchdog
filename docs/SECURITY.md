# Security

What Cloud Watchdog protects, how, and what it does not try to protect against.
The checks behind each claim are in [`REVIEW.md`](REVIEW.md); the tests are
named next to each one.

## What is worth protecting

1. **The AWS account.** The app holds a signed-in AWS session. Misused, it could
   read the account's inventory or, with the optional policy, stop machines.
2. **The user's credentials.** Access keys or SSO tokens on this computer.
3. **Trust in the numbers.** A price shown as exact when it is not, or a
   resource shown as free when it is billed, costs real money. That is covered
   in [`ARCHITECTURE.md`](ARCHITECTURE.md); this file is about attacks and leaks.

## Least privilege in AWS

- The app needs one policy, [`iam/cloud-watchdog-readonly.json`](../iam/cloud-watchdog-readonly.json):
  ten `Describe`/`List` actions for the seven resource kinds, plus
  `cloudwatch:GetMetricData`, two `freetier:Get*` actions and
  `pricing:GetProducts`. No write action of any kind.
- Stopping needs a second, separate policy,
  [`iam/cloud-watchdog-actions.json`](../iam/cloud-watchdog-actions.json):
  `ec2:StopInstances` on instances and `rds:StopDBInstance` on databases, and
  one read-only check. Nothing can start, modify, delete or terminate.
- `tests/unit/awsCalls.test.ts` reads every AWS SDK command the source imports
  and fails if its IAM action is missing from these files, if anything but a
  read or those two stops is imported, or if a stop is imported outside its
  driver.

## Credentials

- The app never asks for keys and never writes any. It passes a profile name to
  the AWS SDK's own credential chain, which reads `~/.aws` and keeps the
  credentials in memory.
- Only **profile names** cross into the user interface (`profiles:list`).
- `settings.json` holds the profile name. The database holds the account id and
  the ARN of the signed-in identity. Neither holds a key, secret or token
  (`core/store/migrations.ts`; `settings.ts` drops unknown fields on load).
- Expired SSO sign-ins are not refreshed by the app: it shows the
  `aws sso login` command for the user to run.

## Stopping is opt-in and guarded

Off by default, and switched off again when the profile changes. Switching it on
takes a native Windows dialog that names the account; the setting cannot be
changed through `settings:update`. Every stop needs a fresh look at the resource
in AWS, a single-use token valid for 60 seconds, and a second native dialog
whose default button is Cancel. The page cannot draw, read or answer either
dialog. The guard checks again after the dialog that nothing changed, and
writes an audit row before the call. Details and the 33 deliberate breaks the
tests caught: `REVIEW.md`, "Stop actions (M10)".

## The renderer is untrusted

The UI is a web page. It is treated as if it could be compromised (for example
by a malicious resource name rendered in a table), so it can do very little:

| Protection | Where | Tested by |
|---|---|---|
| `contextIsolation`, `sandbox`, no `nodeIntegration`, `webSecurity` on, for every window | `main/windows.ts` | e2e `smoke.spec.ts` reads the live preferences |
| CSP: `default-src 'self'`, no inline script or style, `object-src`, `frame-src`, `form-action` and `base-uri` all none | `renderer/index.html` | e2e CSP test |
| No navigation, no `window.open`, no webviews | `main/security.ts` | e2e smoke tests |
| Every permission refused except clipboard write (for "Copy command") | `main/security.ts` | |
| Only `window.watchdog` is exposed; it is frozen and lists 12 named calls | `preload/index.ts` | e2e lists its exact keys |
| Every IPC message: sender must be the app's own page, input must pass a strict zod schema | `main/senderCheck.ts`, `main/ipcSchemas.ts` | `ipcHandlers.test.ts`, e2e "rejects malformed input" |
| No "call AWS", "run SQL" or "open URL" channel. Resources are named by a key that main looks up. | `shared/ipc.ts` | |
| Links open in the browser only after an allow-list check: HTTPS, `*.console.aws.amazon.com` or `docs.aws.amazon.com`, no credentials or port in the URL. The URL is built in main, never sent by the page. | `main/externalLinks.ts` | `externalLinks.test.ts` |
| React escapes all text; there is no `dangerouslySetInnerHTML` | `src/renderer` | |

## The installed app

| Protection | Tested by |
|---|---|
| Electron fuses: the exe cannot run as plain Node (`ELECTRON_RUN_AS_NODE`), ignores `NODE_OPTIONS` and `--inspect`, loads code only from `app.asar`, and checks `app.asar` against a hash embedded in the exe | `tests/packaged/smoke.spec.ts` reads the fuses |
| The development switches are ignored: the pretend AWS account (`WATCHDOG_FAKE_AWS`), its dialog auto-answer, the data-folder override and the dev-server URL | `tests/packaged/smoke.spec.ts` sets them all |
| Installs per user, with no administrator rights and no service | `electron-builder.yml` |
| Talks to nothing but AWS: no server, telemetry, crash reporting or auto-update. Fonts and icons are bundled. | |
| SQL is parameterised, all of it in `core/store/repo.ts` | |

## Dependencies

`npm audit --omit=dev` reports **0** vulnerabilities in what ships. The full
`npm audit` reports 15 moderate advisories, all the same `minimatch`
denial-of-service issue inside build tools (ESLint, typescript-eslint,
electron-builder). They run only on a developer's machine, on the project's own
files, and are not in the installer.

## What this does not protect against

- **Someone who can run code as you on this computer.** They can read `~/.aws`
  directly, so the app cannot add protection. The same goes for editing
  `settings.json`: it can switch stopping on without the first dialog (the
  dialog before each stop still appears). And a program started by you can start
  the app with `--remote-debugging-port` and script its window; the packaged
  smoke test uses exactly this.
- **An unsigned installer.** Windows cannot tell a genuine
  `Cloud-Watchdog-Setup.exe` from a tampered one; SmartScreen warns about both.
  Build from source if that matters to you.
- **A compromised AWS SDK or Electron release** from npm. Versions are pinned in
  `package-lock.json` and installed with `npm ci`.

## Reporting a problem

Open an issue in the repository, or for something sensitive, contact the
maintainer privately through their GitHub profile rather than in a public issue.
