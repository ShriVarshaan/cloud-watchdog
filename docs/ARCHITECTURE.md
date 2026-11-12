# Architecture

A short tour of how Cloud Watchdog fits together. The full design, with the
reasons for each choice, is section 3 of [`PLAN.md`](../PLAN.md).

## The three processes

```
┌──────────────────────── main process (Node) ────────────────────────┐
│ src/main      tray, windows, scheduler, notifications, IPC handlers │
│ src/core      scan engine, scanners, pricing, free tier, rules,     │
│               actions, SQLite store   (no Electron imports)         │
└───────────────▲─────────────────────────────────────────────────────┘
                │ typed IPC: 12 request channels + 2 events, validated in main
┌───────────────┴──────── preload (contextBridge) ────────────────────┐
│ src/preload   exposes window.watchdog, nothing else                 │
└───────────────▲─────────────────────────────────────────────────────┘
┌───────────────┴──────── renderer (sandboxed) ───────────────────────┐
│ src/renderer  React: tray popover + main window. No Node, no AWS.   │
└─────────────────────────────────────────────────────────────────────┘
src/shared    types and the IPC contract, imported by all three
```

**The rule that keeps it explainable: `src/core` has no Electron imports.**
Everything that decides something (what is running, what it costs, who pays,
what to warn about, whether a stop is safe) is plain TypeScript, unit-tested in
Node with Vitest. `src/main` is wiring, and even its largest file,
`controller.ts`, takes Electron's pieces as arguments so it is tested the same
way. The renderer may import only `src/shared`; lint enforces it.

## One scan, start to finish

```
scheduler (every 15 min, on wake, or "Scan now")
  └─ scan engine            src/core/scan/engine.ts
       fan out: 7 scanners × every enabled region
       limiter: 8 calls at once, 3 per service
       each task settles alone: a failure becomes a ScanError, never a failed scan
  └─ pipeline               src/core/scan/pipeline.ts
       1. price each resource         pricing/engine.ts
       2. read plan and free tier     freetier/planState.ts   (at most hourly)
       3. who pays for each one       freetier/coverage.ts
       4. credit runway               freetier/runway.ts
       5. CPU for idle detection      rules/idle.ts           (at most hourly)
       6. rules, then flag lifecycle  rules/engine.ts, flagLifecycle.ts
       7. save, prune history         store/repo.ts
  └─ controller             src/main/controller.ts
       state:changed to the windows, toasts for new flags, tray tooltip
```

Every step after the engine degrades instead of failing: no plan means
"coverage unknown" and a banner, no price list means estimates from a bundled
snapshot, no CloudWatch means no idle warning. Each adds a `ScanError` the UI
lists under Scan Problems.

## The four ideas worth knowing

**1. Staleness instead of false "resolved".** If one scanner fails in one
region (throttling, a missing permission), what was last seen there is carried
forward with `stale: true`. It stays in the burn rate, its warnings are left
exactly as they were, and the UI says the data is old. Treating a failed call as
"nothing there" would make the burn rate drop and resolve warnings that are
still true.

**2. Honest prices.** Each price is `exact`, `estimate` or `unknown`
(`pricing/engine.ts`). Exact means every part of the rate came from the Price
List API as a single matching product, with nothing assumed. A monthly price
divided into hours, a bundled or expired price, or a spot instance priced at its
on-demand ceiling is an estimate. If any part of a rate is missing, the whole
resource is unknown and shows "—", never a partial sum. Usage charges that
cannot be priced (data transfer, NAT data processing) are listed by name.

**3. Coverage leans towards "you pay".** `freetier/coverage.ts` is a decision
table, first match wins. Credits left means covered; an expired plan means not
covered; anything uncertain is "unknown", never "covered". Telling someone a
resource is free when it is not is the expensive mistake.

**4. Flags have a lifecycle.** A rule that matches raises a flag once and
notifies once. While it keeps matching, the flag is refreshed but never
notified again. When the rule clearly stops matching, it resolves. When the
rule cannot judge (stale data, missing CPU figures), nothing changes. Dismissing
hides a flag until a time or until it resolves (`rules/flagLifecycle.ts`).

## The IPC boundary

The renderer reaches the main process only through `window.watchdog`, a frozen
object the preload builds from the contract in `src/shared/ipc.ts`. Every call
is an `invoke`. The main process checks that the sender is the app's own page,
validates the input with a strict zod schema (unknown fields are rejected), and
returns `{ ok: true, value }` or `{ ok: false, error }`.

| Channel | What it does |
|---|---|
| `app:getState` | identity, settings, last scan summary, whether a scan runs, any problem |
| `profiles:list`, `profiles:select` | profile names only; select signs in and starts scanning |
| `scan:run`, `scan:getLatest` | start or join a scan; the last full result |
| `flags:dismiss` | hide a warning for some hours, or until it resolves |
| `settings:update` | interval, notifications, login item, rules (not the profile or stopping) |
| `resource:manualSteps`, `resource:openConsole` | console link and CLI command, both built in main |
| `actions:setEnabled`, `actions:preview`, `actions:execute` | the opt-in stop flow (below) |

Two events go the other way: `scan:progress` and `state:changed`. There is no
"call AWS" or "run SQL" channel, and the renderer never sends a URL or an ARN:
it names a resource by a key the main process looks up in its own data.

## Stopping something

The only code that changes an AWS account is `core/actions/stopEc2.ts` and
`stopRds.ts`, one SDK call each. `core/actions/guard.ts` stands in front:

1. Off by default; switching on takes a native dialog naming the account.
2. A preview reads the resource from AWS now, not from the last scan, and lists
   consequences and blockers. Only with no blockers does it issue a token:
   single use, 60 seconds, tied to this session.
3. Execute: a native confirmation (Cancel is the default), then the guard
   checks again that the session, account and resource are exactly as
   previewed, writes an `action_log` row, and only then calls AWS.

A unit test (`tests/unit/awsCalls.test.ts`) fails if the source imports any
AWS call that is not a read (`Describe*`, `Get*`, `List*`) or one of those two
stops, or imports a stop outside its driver file. The pretend account is the one
exception: it imports them to answer them, and cannot send one.

## Storage

One SQLite file, `%APPDATA%\Cloud Watchdog\watchdog.db`, through the
`node:sqlite` module built into Electron's Node (no native build).
`core/store/db.ts` is the only file that touches the driver, so it can be
swapped; `repo.ts` holds every SQL statement, all parameterised.
Settings are a separate `settings.json`, validated on load.

| Table | Holds |
|---|---|
| `scans`, `scan_errors`, `observations` | each scan, what failed, each resource's state and price per scan (30 days) |
| `resources` | the latest view of each resource, with when it was first and last seen and whether it is stale |
| `flags` | warnings and their lifecycle |
| `price_cache`, `plan_snapshots`, `cpu_cache` | what the Price List, Free Tier and CloudWatch said, to call them less |
| `action_log` | every stop the app made |

## Testing

| Layer | How |
|---|---|
| `src/core`, `src/main` logic | Vitest with `aws-sdk-client-mock` and sanitised recordings of real AWS responses (`tests/fixtures`). A setup file blocks every non-loopback connection, so no unit test can reach AWS. |
| IAM policy | a test reads every SDK command the source imports and checks its IAM action is in `iam/*.json` |
| The running app | Playwright drives the built app against a pretend AWS account (`main/fakeAws.ts`, development builds only): popover, table, inspector, settings, stopping, and axe accessibility checks in light and dark mode |
| The packaged exe | `tests/packaged`: fuses, page from `app.asar`, IPC, database, and that development switches are ignored |

## Folder map

```
src/shared/          types.ts, ipc.ts (the contract), format.ts, explain.ts
src/core/aws/        client factory (profile, region, adaptive retry), identity, regions, error classifier
src/core/scan/       engine, limiter, pipeline, persist
src/core/scanners/   one file per resource kind
src/core/pricing/    engine, price keys per kind, Price List client, bundled snapshot
src/core/freetier/   plan state, coverage, runway
src/core/rules/      rules, engine, idle detection, flag lifecycle
src/core/actions/    guard, stop drivers, manual steps
src/core/store/      db, migrations, repo
src/main/            entry, controller, IPC handlers and schemas, scheduler, windows, tray, security
src/preload/         the bridge
src/renderer/        popover/, main-window/, components/
iam/                 the two IAM policies
scripts/             fixture and price recorders, bundled-price and icon builders
```
