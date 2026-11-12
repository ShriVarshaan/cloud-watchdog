# Final review (M12)

Reviewed on 2026-11-10 at commit `c60a9fe`, after milestones M1 to M9. The stop
actions (M10) and the installer (M11) did not exist yet: `PLAN.md` puts this
review before them on purpose. **M10 needs its own review when it is built**,
because it is the only code that changes anything in an AWS account.

## Result

| | |
|---|---|
| `npm run check` | passes, 822 unit tests |
| `npm run test:e2e` | passes, 22 tests against the built app with the fake AWS account |
| Critical findings open | none |
| Fixed during the review | 1 bug (high), 1 missing test |
| Left for follow-up | 7 medium, 11 low (below) |
| Still to do by hand | Access Analyzer policy check, the smoke checklist (both below) |

## Fixed during the review

**1. A profile switch during a scan could make the next scan fail (high).**
`src/main/scheduler.ts`. When the profile was changed while a scan was running,
the old scan finishing cleared the scheduler's "a scan is running" marker, which
by then belonged to the new profile's scan. Pressing "Scan now" at that moment
ran the pricing-and-save pipeline twice on one scan; the second save hit the
duplicate scan id and the UI showed "The scan failed unexpectedly". No wrong
data was saved. Fixed in `c9d5e2f` with a test that fails without the fix.

**2. The IAM policy was not checked against the calls the app really makes (test gap).**
`PLAN.md` promised a test that fails when the code calls an API the policy does
not grant. Only the scanners' self-declared `requiredActions` were checked; the
pricing, Free Tier and CloudWatch calls were not. `tests/unit/awsCalls.test.ts`
(`c60a9fe`) now reads every AWS SDK command and paginator imported under `src/`
and checks three things: all are `Describe*`, `Get*` or `List*`; all are granted
by `iam/cloud-watchdog-readonly.json`; the policy grants nothing unused. Tried
against two deliberate breaks (a policy action removed, a `TerminateInstances`
import added): both fail the test.

Two problems found earlier, while building, are worth knowing about:

- The fixture sanitiser let the real account id through inside a base64
  pagination token (fixed in M6, `bcb998c`; nothing reached git).
- An M3 test hung about one run in six on a busy machine (fixed in M5, `85de9f5`).

## Security

| Check | Result | Evidence |
|---|---|---|
| IPC surface matches `PLAN.md` 3.5 | Yes: the same 11 channels and 2 events. Two fields were added to payloads: `AppState.problem` and `ManualSteps.cliNote`. | `src/shared/ipc.ts`; e2e test lists the exact keys of `window.watchdog` |
| No generic "call AWS" or "run SQL" channel | Yes | `src/shared/ipc.ts` |
| Every IPC input validated, sender checked | Yes, strict zod schemas; unknown fields rejected | `ipcSchemas.ts`, `ipcHandlers.test.ts`, e2e "rejects malformed input" |
| Renderer sandboxed, context-isolated, no Node | Yes | e2e smoke tests read the live web preferences |
| Navigation, `window.open`, webviews blocked | Yes | `security.ts`, e2e smoke tests |
| CSP `default-src 'self'`, no inline script or style | Yes. The gauge width is set through the DOM style API, which the policy allows. | `index.html`, e2e CSP test |
| Links opened only through an allow-list | Yes: one call to `shell.openExternal`, behind `isAllowedExternalUrl` (HTTPS, AWS console and docs hosts, no credentials or port). The UI sends a resource key, never a URL. | `externalLinks.test.ts`, `controller.test.ts` |
| Permissions | All refused except writing to the clipboard (for "Copy command"). Reading the clipboard is refused. | `security.ts` |
| Credentials never stored or logged | Yes. Keys stay in the SDK's provider chain in memory. The database, `settings.json` and logs hold a profile name, account id and ARN at most. | schema in `migrations.ts`; `settings.ts` drops unknown fields |
| SQL injection | Not possible: every statement is parameterised and all SQL is in `repo.ts` | `repo.ts` |
| The app cannot change an AWS account | Yes, until M10: every imported SDK call is read-only | `awsCalls.test.ts` |
| Fake AWS mode cannot run in an installed app | By inspection only: `app.isPackaged ? null : ...` in `index.ts`. No test can cover a packaged build yet. **Since M11, tested:** the packaged smoke test starts the exe with every development switch set and checks they are ignored. | `src/main/index.ts`, `tests/packaged/smoke.spec.ts` |
| Dependencies | Production dependencies: 0 known vulnerabilities. Development tools: 10 moderate, all in the ESLint toolchain (`minimatch` and others). | `npm audit --omit=dev`, `npm audit` |

## Correctness

Besides reading the code, I changed the code on purpose in small ways
(mutations) and checked that a test fails for each.

| Area | Mutations caught | Notes |
|---|---|---|
| Scan engine: staleness, single flight | 4 of 4 | Carry-forward removed, region-list failure ignored, stale flag inverted, single flight removed |
| Pricing confidence | 7 of 7, after adding one test | One mutation survived at first ("AWS has no such price" treated as a failure); a test was added in M5 |
| Coverage table | 5 of 5 | |
| Rules at their boundaries | 5 of 5 | |
| Flag lifecycle, idle detection, runway, pipeline | not mutated | Covered by tests written first; no mutation run |
| Action guards | not applicable | M10 is not built |

## The IAM policies

- `iam/cloud-watchdog-readonly.json` matches the code exactly (the test above).
  `sts:GetCallerIdentity` needs no permission and is not in it.
- The `freetier:` action names and `Resource: "*"` were confirmed against AWS's
  machine-readable service reference in M6.
- **Not done: `aws accessanalyzer validate-policy`.** It needs a call with your
  profile:

  ```
  aws accessanalyzer validate-policy --policy-type IDENTITY_POLICY --policy-document file://iam/cloud-watchdog-readonly.json --profile default
  ```

  An empty `findings` list means the policy is valid.
- `iam/cloud-watchdog-actions.json` does not exist yet (M10). Open question 9 in
  `PLAN.md`, resource-level ARNs for the two stop actions, is checked then.

## Open findings

### Medium

1. **After a restart the last result is not shown until the first scan ends.**
   `controller.start()` does not load the saved result, because the account id
   is only known after signing in. For about a minute the popover says "Not
   scanned yet". The `scans` table stores the profile, so the last scan for the
   saved profile can be loaded at start.
2. **Resources of a region that keeps failing stay forever.** If a region fails
   on every scan (say a permission was removed), what was last seen there is
   carried forward as "old data" indefinitely, with its price in the burn rate.
   Suggest dropping carried-forward resources after a number of days, or
   showing how old the data is.
3. **"At most N days" is nearly always shown.** Any running instance, database
   or NAT gateway lists data transfer as an excluded charge, which marks the
   runway as an upper bound. The qualifier is honest but stops carrying
   information. Suggest marking it only for unpriced resources and for
   exclusions that are usually large (NAT data, load balancer capacity units).
4. **Free-allowance matching is unverified.** Which resources the older
   "12 Months Free" allowances cover (`coverage.ts`) is from AWS's documentation,
   not from a recording: the test account is on the free plan. It only matters
   for a paid account without credits, and it errs towards "not covered".
5. **Price filters were checked against a recording, not by narrow live calls.**
   The recording used broad queries that were narrowed locally. The app has now
   run once against the real account; whether that run priced real resources
   was not recorded (see the smoke checklist).
6. **Development-tool vulnerabilities.** 10 moderate advisories in the ESLint
   toolchain. They do not ship in the app. `npm audit fix` resolves some.
7. **CI status not checked.** The GitHub CLI is not installed on this machine,
   so I could not see whether the Actions runs pass. The e2e tests show real
   Windows notifications, which may behave differently on the CI runner.

### Low

1. Saving a scan and updating its flags are two steps, not one transaction. A
   crash between them leaves the scan saved with the previous flags.
2. `cpu_cache` and `price_cache` rows are never deleted. Both stay small.
3. `settings:update` accepts rule ids the app does not have, and any number of
   them. They are stored and ignored.
4. The fake AWS account's code ships inside the installed app (switched off).
5. Running the e2e tests shows real Windows notifications on the developer's machine.
6. An RDS instance is charged for instance hours in every state except
   `stopped`, including `creating` and `failed`, which over-states the cost briefly.
7. Software fees of AWS Marketplace images are not named among the excluded charges.
8. The plan is read at most hourly, and "Scan now" does not bypass that.
9. The popover has no way to open the main window; the tray menu does it.
10. The same small pieces of knowledge are written in more than one place (see
    the architecture notes).
11. `Resource.createdAt` holds the latest start time for EC2 instances, not the
    creation time. The rules rely on this; the name does not say it.

## Architecture notes

`PLAN.md` asks for one pass with the `improve-codebase-architecture` skill. That
skill is built around a sub-agent, an HTML report and a question-and-answer
session, and it can only be started by the user, so it was **not run**. This is
my own shorter pass instead.

The structure holds up: `src/core` has no Electron imports, the renderer imports
only `src/shared` (enforced by lint), and each stage of a scan is one module
with one entry point (`engine`, `pricing/engine`, `planState`, `coverage`,
`runway`, `rules/engine`, `flagLifecycle`, joined in `scan/pipeline.ts`).
`main/controller.ts` is the largest file; it is one module with one job (state
plus IPC handlers) and is fully tested without Electron, so I would leave it.

Three places where knowledge is duplicated and would be better owned once:

- **Usage-type prefixes.** `pricing/priceListClient.ts` and `freetier/coverage.ts`
  each have their own pattern for the region prefix of an AWS usage type.
- **What each resource kind is.** Its display name is in `shared/explain.ts` and
  again in `main/notifications.ts`; "the state in which it is running" is in
  `rules/rules.ts` and again in `rules/idle.ts`.
- **Whether a flag is hidden.** `rules/flagLifecycle.ts`, `Popover.tsx` and
  `MainWindow.tsx` each test `dismissedUntil`. `isDismissed` belongs in `src/shared`.

The 730 hours in a month is also defined twice (`pricing/engine.ts`, `shared/format.ts`).

## Stop actions (M10), reviewed on 2026-11-11

Built after the review above. This is the review the top of this file asks for.

| | |
|---|---|
| `npm run check` | passes, 948 unit tests |
| `npm run test:e2e` | passes, 28 tests (6 new, for stopping) |
| Deliberate breaks caught by a test | 33 of 33 |
| Tried against a real AWS account | **no** (see the checklist below) |

**What can change an AWS account.** Two calls: `StopInstances` for one instance
id, without `Force` or `Hibernate`, and `StopDBInstance` for one identifier,
without a snapshot. `tests/unit/awsCalls.test.ts` fails if any other call that
is not `Describe*`, `Get*` or `List*` is imported, or if either stop call is
imported outside its own driver file. (`main/fakeAws.ts` also imports them, to
answer them in the pretend account; it cannot send one.)

**What stands between the UI and those calls** (`src/core/actions/guard.ts`):

| Step | Where it is tested |
|---|---|
| Off by default; only `actions:setEnabled` switches it on, after a native dialog that names the account and the policy | `controller.test.ts`, `ipcHandlers.test.ts`, e2e |
| Switched off again when another profile is chosen | `controller.test.ts` |
| A preview looks at the resource in AWS, not at the last scan | `guard.test.ts` |
| A token only when nothing blocks the stop; 60 seconds; one use; only in the session that issued it | `guard.test.ts` |
| A native confirmation naming the resource, region and account. Cancel is the default. One dialog at a time. | `confirmations.test.ts`, `controller.test.ts` |
| After the confirmation: the session still exists, the account is the same, and the resource is exactly as previewed | `guard.test.ts` |
| A row in `action_log` for every execute, written before the stop call | `guard.test.ts`, `store.test.ts` |
| Nothing is stopped when the database could not be opened | `controller.test.ts` |

The 33 breaks were things like "a token can be used twice", "the account is not
checked again", "an Auto Scaling group is not a blocker", "the stop is sent
with `Force`" and "enabling skips the dialog". Each made at least one test fail.

**Differences from `PLAN.md`**

- One more IPC channel, `actions:setEnabled`. The plan asked for a separate
  step with its own confirmation and did not name the channel.
- One more read-only permission, `ec2:DescribeInstanceTypes`, in the actions
  policy. It is how the app learns that an instance type has instance-store disks.
- Previews are not written to `action_log`, only executes. A preview changes nothing.
- The restart warning (`rds-restarted`) only knows about databases this app
  stopped, and decides from scan history. If the computer was off for the whole
  7 days, a database the user started by hand in that time is also flagged.

**Open findings**

1. *Medium.* **Not tried on a real account.** Everything above ran against
   mocks and the fake account. The error names the code relies on
   (`DryRunOperation`, `UnauthorizedOperation`, `InvalidInstanceID.NotFound`,
   `DBInstanceNotFoundFault`) and the shape of `NetworkInterfaces[].Association`
   are from the AWS documentation and SDK types.
2. *Medium.* **`aws accessanalyzer validate-policy` was not run** on
   `iam/cloud-watchdog-actions.json` (same command as for the read-only policy).
3. *Low.* An instance with stop protection (`DisableApiStop`) is not detected at
   the preview. AWS refuses the stop and the app shows AWS's message.
4. *Low.* `actionsEnabled` is a line in `settings.json`. Someone who can edit
   that file can switch stopping on without the first dialog. The dialog before
   each stop cannot be skipped that way.
5. *Low.* The demo account's GPU instance is blocked (its type has an
   instance-store disk). That is correct, but it means the most expensive kind
   of forgotten instance often has to be stopped by hand.
6. *Low.* The auto-answer for dialogs in the end-to-end tests
   (`WATCHDOG_FAKE_CONFIRM`) is read only with the fake account, and the fake
   account only in a build that is not packaged. Like the fake account itself,
   that is checked by reading `index.ts`, not by a test.

**Checklist for the first real stop** (needs the actions policy attached)

- [ ] Switching on shows the dialog with the real account id
- [ ] Without the actions policy, the preview of a running `t3.micro` says the profile is not allowed
- [ ] With the policy, the preview shows consequences, and the confirmation names the instance, region and account
- [ ] The instance stops; the next scan shows it stopped; `action_log` has one `stopped` row
- [ ] An instance in an Auto Scaling group gets a blocker and no Stop button to confirm
- [ ] A test RDS database stops, and a `stopped` row is written

## Manual smoke checklist

On 2026-11-10 the app was started with `npm run dev` against the real account
and reported as "seems to be working". The individual checks below were **not
confirmed one by one**, so they are still open.

- [ ] The header shows the real account id and identity
- [ ] A scan completes; the Scan problems tab is empty or shows only expected entries
- [ ] An unattached volume and an unused Elastic IP, created for the test, are flagged and priced
- [ ] Removing the `freetier` statement from the policy shows the "Plan details unavailable" banner
- [ ] Removing the `pricing` statement turns prices into estimates or "—"
- [ ] A notification appears for a new warning, and clicking it opens that resource
- [ ] The tray tooltip shows the burn rate
