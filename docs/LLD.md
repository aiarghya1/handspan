# Handspan — Low-Level Design

**Audience.** An engineer who will extend, review or debug this code. It
specifies interfaces, algorithms, invariants and extension points. The
[HLD](HLD.md) covers why the system is shaped this way; this document assumes
that shape and gets concrete.

Every enumeration below is transcribed from the source, not summarised.

---

## Contents

1. [Module map and dependency rules](#1-module-map-and-dependency-rules)
2. [The surface seam](#2-the-surface-seam)
3. [Perception: the naming cascade](#3-perception-the-naming-cascade)
4. [Targeting: the resolution ladder](#4-targeting-the-resolution-ladder)
5. [The artifact schema](#5-the-artifact-schema)
6. [The linter](#6-the-linter)
7. [Conditions](#7-conditions)
8. [The replay engine](#8-the-replay-engine)
9. [The result contract](#9-the-result-contract)
10. [Policy](#10-policy)
11. [Escalation and control transfer](#11-escalation-and-control-transfer)
12. [Discovery and compilation](#12-discovery-and-compilation)
13. [Observability and redaction](#13-observability-and-redaction)
14. [Multi-tenancy](#14-multi-tenancy)
15. [The catalog projection](#15-the-catalog-projection)
16. [Testing strategy](#16-testing-strategy)
17. [Extension recipes](#17-extension-recipes)

---

## 1. Module map and dependency rules

| Module | LOC | Files | Depends on (internal) |
|---|---:|---:|---|
| `surface` | 1361 | 4 | — |
| `llm` | 371 | 1 | — |
| `policy` | 420 | 2 | `surface`, `artifact` *(types only)* |
| `obs` | 168 | 1 | `surface`, `artifact` *(types only)* |
| `artifact` | 1064 | 6 | `surface`, `policy` |
| `escalation` | 650 | 2 | `surface`, `policy`, `obs` |
| `replay` | 1190 | 4 | `surface`, `artifact`, `policy`, `obs`, `escalation` |
| `discover` | 1191 | 6 | all of the above, plus `replay`, `llm` |
| `catalog` | 113 | 1 | `artifact` |
| `cli` | 1121 | 8 | everything; nothing depends on it |

**Rules enforced by review, not tooling:**

1. Nothing above `surface` names a CSS selector, a coordinate, or a Playwright
   type. The one exception is the `hints.selector` field, which is carried
   opaquely as tier-5 data and interpreted only inside an adapter.
2. `artifact ↔ policy` is the only cycle. `artifact` imports `createRedactor`
   and `Risk` from `policy` at runtime; `policy` imports `Risk` and
   `StepActionKind` back with `import type`. The back edge does not exist at
   runtime.
3. `cli` is a leaf. Every command is `run(argv, io, sessionFactory) => Promise<number>`.
   `bin/handspan.ts` holds the only `process.argv` read and the only
   `process.exit` call in the codebase, which is what makes the commands
   testable in-process.

The `artifact` module is six files rather than one because three of its
responsibilities are separable and only one of them is on the hot path:

| File | Responsibility | Imported by |
|---|---|---|
| `schema.ts` | The capability type | everything |
| `template.ts` | `{{param}}` / `{{secret:}}` resolution | replay, lint |
| `store.ts` | Persistence, hashing, approval, the catalog | replay, catalog, cli |
| `lint.ts` | The 22 static checks | replay precheck, cli |
| `tenant.ts` | `mapAllRefs`, `specializeForTenant` | replay precheck |
| `app-profile.ts` | Application-level conditions | discover, cli |

`lint.ts` and `tenant.ts` depend on `store.ts` and nothing depends on them
except the precheck path, so the static half of replay stays free of any
browser or driver dependency.

## 2. The surface seam

```ts
export interface SurfaceDriver {
  readonly surface: SurfaceKind;

  observe(opts?: { screenshot?: boolean }): Promise<Observation>;
  resolve(ref: ControlRef): Promise<Resolution>;

  navigate(url: string): Promise<void>;
  click(res: Resolution): Promise<void>;
  fill(res: Resolution, value: string): Promise<void>;
  select(res: Resolution, value: string): Promise<void>;
  press(key: string, res?: Resolution): Promise<void>;
  readText(res: Resolution): Promise<string>;

  currentUrl(): string;
  screenshot(opts?: ScreenshotOptions): Promise<Buffer>;
  structureSnapshot(): Promise<string>;         // HTML per frame; control tree on desktop
  waitForQuiescence(timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}
```

Note the shape of the act methods: they take a `Resolution`, not a `ControlRef`.
Resolution is a separate, explicit step, which is what lets the engine inspect
*how well* a target resolved before deciding to act on it.

### 2.1 Control roles

A closed vocabulary of 17, chosen as the intersection of what HTML, ARIA and
Windows UI Automation can all express:

```
button  link  textbox  password  checkbox  radio  combobox  option
cell  row  heading  banner  alert  dialog  tab  image  text
```

`password` is separated from `textbox` because a driver must never read a
password back, and a recorder must never log its value. Making that a role
rather than a flag means the distinction cannot be lost in a refactor.

### 2.2 `ControlRef` — the durable reference

```
role         ControlRole                 required
name         string                      the accessible name
nameMatch    'exact'|'normalized'|'contains'|'regex'
scope        { frame?, section?, rowContaining? }
ordinal      number                      last resort, within the scope
hints        { selector?, nearText? }    tier-5/tier-4 fallbacks
```

Scope is the part that makes legacy screens tractable. `section` is the screen
title a control sits under — a real heading where one exists, otherwise the
styled-div-as-title-bar that these applications use. `rowContaining` scopes to a
grid row by a value in it, which is how "the balance on the regular savings row"
stays correct when the rows reorder.

### 2.3 `Observation`

A flattened list of `Control`s across all frames, plus per-frame views
(`FrameView`), the current URL, and optionally a screenshot. Flattened rather
than a tree because every consumer — matcher, renderer, condition evaluator —
wants "all controls matching X", and a tree would make each of them walk it.

## 3. Perception: the naming cascade

`src/surface/web/extract.ts` (516 lines) runs *inside the page*. It exists
because the accessibility name of a control on these surfaces is usually empty:
the label is a `<td>` next door with no `id`, no `<label for>`, no `aria-label`.
Chromium computes nothing, so there is nothing to target.

The cascade is a superset of the four sources the ARIA algorithm uses, in
descending strength. `NameSource` is recorded on every control so a drift can be
diagnosed later:

| # | `NameSource` | Where the name came from |
|---|---|---|
| 1 | `aria-label` | The attribute |
| 2 | `aria-labelledby` | Referenced elements, joined |
| 3 | `label-for` | A `<label for>` pointing at it |
| 4 | `label-wrap` | A `<label>` wrapping it |
| 5 | `adjacent-cell` | The cell to its left in a **layout** table |
| 6 | `column-header` | The header above it in a **data grid** |
| 7 | `preceding-text` | Inline text immediately before it |
| 8 | `placeholder` | The attribute |
| 9 | `title` | The attribute |
| 10 | `alt` | For images and image inputs |
| 11 | `value` | A submit button's own value |
| 12 | `text` | Its own text content, for links and buttons |
| 13 | `none` | Nothing found; addressable only by ordinal |

### 3.1 Why grid and layout tables are distinguished

Legacy applications use `<table>` for both page layout and data. The distinction
decides what a durable reference looks like:

- **Layout table** — the label is horizontal, in the cell to the left. Name from
  `adjacent-cell`; there is no meaningful row identity, so ordinal is the
  fallback scope.
- **Data grid** — the label is vertical, in the column header. Name from
  `column-header`, and the row must be identified by its *content*
  (`rowContaining`), because row order is data and will change.

Getting this wrong produces a reference that works on the recording and silently
reads the wrong cell on the next run — the exact failure this whole design is
built to make impossible.

### 3.2 Other in-page behaviours worth knowing

- **Handle stamping.** Each control gets a `data-hs-h` attribute so it can be
  addressed again cheaply across frames. This mutates the page, which is a real
  cost, accepted because CDP backend node ids are not stable across the frame
  navigations these apps do constantly.
- **Error-banner detection.** Legacy error text carries no role. A red-channel
  heuristic on computed colour promotes such text to `alert`, which is what lets
  a validation message become a detectable outcome.
- **Empty frames return early**, before any DOM walk, because a frameset's
  spacer frames are numerous and have no body.

## 4. Targeting: the resolution ladder

`src/surface/match.ts` is pure: `ControlRef` + `Control[]` → `Resolution`. No
I/O, no driver. That is why the matcher is exhaustively testable without a
browser.

```ts
export const LOCATOR_TIERS = [
  'role+name+scope', // 1 semantic, fully scoped - what we want every time
  'role+name+frame', // 2 semantic, scope drifted (section renamed, row moved)
  'role+name',       // 3 semantic, frame drifted
  'role+nearText',   // 4 label association, name synthesis changed
  'hint-selector',   // 5 surface-specific escape hatch
  'role+ordinal',    // 6 positional; correct only if nothing was inserted
] as const;
```

### 4.1 `resolveFromControls`

```
for tier in TIERS:                        # strongest first
    candidates = candidatesAtTier(ref, controls, tier)
    if candidates is empty:  continue     # drift down a tier
    if len(candidates) == 1: return hit(candidates[0], tier)
    if ref.ordinal is defined and in range:
        return hit(candidates[ref.ordinal], tier)
    return ambiguous(tier, count)         # refuse; do NOT take the first
return not_found
```

Two decisions are load-bearing:

- **Ambiguity is a refusal, not a guess.** Taking the first of several matches
  is how automation posts a transaction against the wrong account. Ambiguity
  becomes `ambiguous_target`, or an intervention when an operator is available.
- **Tier drift is reported, not hidden.** A step that resolved at tier 1 when
  recorded and tier 3 now still runs, but is marked `degraded: true` on its step
  report and appears in `degradedSteps`. That is the early-warning signal for a
  vendor release having moved something, before it becomes an outage.

`sectionMatches` is deliberately loose: legacy headings carry runtime suffixes
("MEMBER DETAIL — 10000"), so an exact section match would fail on every run
but the recording.

### 4.2 `deriveRef` — the inverse

Used at discovery time, and the reason discovery produces durable artifacts.
Given the control acted on *and the whole observation*, it emits the **least
specific reference that is still unambiguous**:

```
try role+name alone           → unique?  emit it
add frame scope               → unique?  emit it
add section scope             → unique?  emit it
if the control is in a data grid:
    add rowContaining = deriveRowLabel(control, controls)
else:
    add ordinal within the narrowest scope tried
always attach hints { selector, nearText } as tiers 4-5
```

Over-specifying is as damaging as under-specifying: a reference pinned to a
section that will be renamed breaks on the next release, even though
`role+name` alone would have been unique forever. `deriveRowLabel` picks the
most identifying cell in the row — preferring a code or description column over
a numeric one, since numbers change and descriptions do not.

## 5. The artifact schema

`src/artifact/schema.ts`. Zod, so the schema *is* the validator and parse
failures are structured.

### 5.1 Top-level

```yaml
apiVersion: handspan.dev/capability/v1
id: <app>.<domain>.<task>          # meridian.member.savings_balance
version: 1.0.0                     # semver; catalog serves the latest
title: / summary:                  # what a calling agent reads
surface: web | web-legacy | desktop
app:      { id, vendor, vendorVersion, recordedForTenant }
entryUrlTemplate: "{{baseUrl}}/"

params:   { <name>: ParamSpec }    # ─┐
returns:  { <name>: ReturnSpec }   #  │ the public contract
outcomes: [ Outcome ]              #  │ an agent binds only to these
secrets:  [ vault-key ]            # ─┘

steps:      [ Step ]               # ─┐ the implementation
recoveries: [ Recovery ]           # ─┘ an agent must never read these

policy:     { riskTier, allowedOrigins, allowedPathPrefixes, allowedActions, requiresApproval }
provenance: { discoveredBy, approval, stability }
tenantOverrides: [ TenantOverride ]
contentHash: <md5 over everything except provenance>
```

### 5.2 Value types and sensitivity

```
type         string | number | integer | boolean | money | date
sensitivity  none | pii | pii-id | account | secret
```

`sensitivity` is the *real* protection in this system. Pattern-matching PII out
of logs is a backstop that will always have gaps; a declared field is redacted
because it was declared, whatever it happens to contain. `pii-id` is separate
from `pii` because identifiers are the linkable ones, and `secret` values are
never permitted as parameters at all.

A `ParamSpec` also carries `required`, `pattern`, `enum`, `minimum`, `maximum`
and `example`. All of them are checked **before a browser opens**, so a bad call
costs nothing.

### 5.3 Step

```
id            s000, s001, …
intent        prose; the reviewer's handle on the step
action        navigate | click | fill | select | press | extract | assert | wait
phase         signon | navigate | input | commit | read
risk          read_only | reversible_write | irreversible
ref           ControlRef                      (action-dependent)
value         string with {{templates}}        (fill / select)
url           string with {{templates}}        (navigate)
extract       { as, source, transform }        (extract)
waitFor       Condition                        precondition
checkpoint    Condition                        proof the step worked
timeoutMs     number
optional      boolean
onCheckpointFail  fail | continue | escalate
recordedTier  LocatorTier                      for drift detection
```

`phase` exists so a recovery can say *get me back to where I was*. When a
session expires mid-flow, re-authenticating is not enough; the flow has to be
rebuilt to the interrupted point. `replayFrom: signon` means "re-run every step
from the first `signon`-phase step onward", which only works because each step
declares which phase it belongs to.

### 5.4 Outcome

```
id           MEMBER_NOT_FOUND, PERMISSION_DENIED, …
description  what it means, and why this disposition
detect       Condition
disposition  return | escalate
checkAfter   [stepId]     empty = check after every step
extract      [{ as, source: {kind: text, pattern}, transform }]
```

`disposition` encodes the only question the caller cares about: *is this an
answer, or does a person need to see it?* `MEMBER_NOT_FOUND` returns —
retrying will never change it and the caller can act on it. `SIGNON_REJECTED`
escalates — a locked service account is an estate problem no retry fixes.

### 5.5 Recovery

```
id, description
when       Condition          the trigger, evaluated on every observation
do         [ Action | {kind: replayFrom, phase} ]
maxPerRun  number             a recovery that keeps firing is a failure
retryStep  boolean            re-run the interrupted step afterwards
```

## 6. The linter

`src/artifact/lint.ts`. `lintCapability()` returns `LintFinding[]`. Errors block replay before a browser
opens; warnings are review signals. 22 codes:

**Structure** — `api-version`, `duplicate-step-id`, `duplicate-outcome-id`,
`unknown-step-ref`, `action-without-target`, `navigate-without-url`,
`extract-without-spec`, `recovery-empty-phase`

**Contract coherence** — `undeclared-param`, `unproduced-return`,
`undeclared-return`, `unknown-output-ref`, `forward-output-ref`

**Safety** — `undeclared-secret`, `secret-as-param`, `literal-sensitive-value`,
`sensitive-example`, `risk-understated`, `ungated-irreversible`,
`action-not-allowed`

**Integrity** — `hash-mismatch`, `unverified-step`

Three deserve explanation:

- `forward-output-ref` — a step referencing a value extracted by a *later* step.
  Always a compiler or edit bug, and it would fail at runtime with a confusing
  template error; caught statically instead.
- `risk-understated` — a step whose control label the policy engine classifies
  as more dangerous than the step's declared `risk`. This is the check that
  catches a hand-edited artifact quietly downgrading a commit to get past
  approval.
- `hash-mismatch` — the stored `contentHash` does not match a recomputation.
  Since approval is pinned to the hash, any edit to a step revokes the approval
  automatically.

## 7. Conditions

One evaluator serves checkpoints, step preconditions, outcome detection and
recovery triggers. That is deliberate: those four are the same question — *does
this hold on the current screen?* — and one implementation means a fix reaches
all four.

```ts
| { kind: 'urlMatches';      pattern: string }
| { kind: 'textPresent';     text: string; regex?: boolean; frame?: FrameSelector }
| { kind: 'textAbsent';      text: string; regex?: boolean; frame?: FrameSelector }
| { kind: 'controlPresent';  ref: ControlRef }
| { kind: 'controlAbsent';   ref: ControlRef }
| { kind: 'valueMatches';    ref: ControlRef; pattern: string }
| { kind: 'allOf';           of: Condition[] }
| { kind: 'anyOf';           of: Condition[] }
| { kind: 'not';             of: Condition }
```

Conditions are evaluated against an `Observation`, never against the live
driver, so evaluation is pure and testable, and a single observation can answer
many conditions without re-reading the screen. Polling happens in the engine:
`waitFor` re-observes until the condition holds or the timeout expires, so a
slow screen costs latency rather than a failed run.

## 8. The replay engine

`src/replay/engine.ts` (~730 lines). Two entry points.

### 8.1 `precheckCapability` — everything that can fail without a browser

```
lint            → invalid_artifact   (errors only)
tenant resolve  → invalid_artifact   (unknown tenant, unless lenientTenant)
approval        → not_approved       (unattended runs only)
input validate  → invalid_input      (types, patterns, enums, bounds, required)
```

Ordered cheapest-first. A malformed call is refused in milliseconds, and a
caller gets a structured reason rather than a browser timeout.

### 8.2 The step loop

Order is the whole design:

```
1  observe()
2  apply any recovery whose `when` holds        ← before anything else this step
3  wait for `waitFor` precondition              → precondition_failed
4  policy.authorize(action, actor='replay')     → policy_blocked | escalate
5  resolve(ref)                                 → target_not_found | ambiguous_target
6  act
7  re-check the origin allowlist                ← a click can navigate anywhere
8  detect declared outcomes                     → business_outcome | escalate
9  poll `checkpoint` until it holds             → checkpoint_failed
10 extract declared values                       (skipped if the step was skipped)
```

Four of these positions were bugs the test suite found:

- **Step 2 before step 3.** A recovery must run before the precondition is
  judged, or an interstitial dialog fails the precondition of the step that
  would have dismissed it.
- **Step 7 exists at all.** Authorising before the action is not enough, because
  the action itself is what changes where you are.
- **Step 8 before step 9.** When a search returns "no member found", the
  checkpoint "the detail screen is showing" is *also* false. Whichever runs
  first decides whether the caller learns a fact about the member or a fact
  about the automation.
- **Step 10 guarded by the skip.** An optional step that did not run has no
  screen to extract from; extraction there returns a plausible wrong value.

### 8.3 Recovery execution

When a recovery's `when` holds:

1. Record `recovery.applied`; increment its per-run counter, failing on
   `maxPerRun`.
2. Run its `do` actions through the same policy gate as any other action.
3. If one is `replayFrom: <phase>`, re-run every step from the first step of
   that phase up to the interrupted one, then continue.
4. If `retryStep`, **re-run the interrupted step** and only then re-check its
   checkpoint.

Point 4 was a defect: the original code re-checked the checkpoint without
re-running the step, which made mid-flow session-expiry recovery structurally
incapable of succeeding — the checkpoint could not hold because the action that
would satisfy it never re-ran.

### 8.4 Failure classes

13, each mapping to one debugging action:

| Class | Means | First thing to check |
|---|---|---|
| `invalid_artifact` | Static validation failed; nothing ran | Lint output |
| `invalid_input` | Inputs did not satisfy `params` | The caller |
| `not_approved` | Unattended run of an artifact lacking approval | `provenance.approval` |
| `target_not_found` | A ref matched nothing at any tier | Did the app change? |
| `ambiguous_target` | Several matches, no ordinal | Ref needs tighter scope |
| `checkpoint_failed` | Step ran, expected screen never appeared | Screenshot at that step |
| `precondition_failed` | A `waitFor` never became true | Prior step's real effect |
| `app_error` | The application reported an internal error | The app's own logs |
| `session_expired` | Re-authentication did not recover it | Credentials, app timeout |
| `policy_blocked` | Left the allowlist or was refused | Policy config |
| `escalation_timeout` | A human was asked and did not arrive | Operator staffing |
| `driver_error` | The browser or adapter itself failed | Infrastructure |
| `budget_exhausted` | Step or wall-clock budget spent | Loop, or a too-tight budget |

Every failure carries the step id, the resolved and recorded tiers, the
checkpoint's expected-versus-observed text, and a path to the evidence
directory.

### 8.5 No-operator mapping

When no broker is attached, a condition that *would* have escalated must still
produce a correct classification. `NO_OPERATOR_FAILURE` is the total mapping
from the 12 stuck reasons onto failure classes — `control-not-found` →
`target_not_found`, `permission-denied` and `irreversible-approval` →
`policy_blocked`, `unexpected-dialog` → `checkpoint_failed`, and so on. Being a
`Record<StuckReason, FailureClass>` means adding a stuck reason without deciding
its unattended meaning does not compile.

## 9. The result contract

```ts
type ReplayStatus = 'success' | 'business_outcome' | 'escalated' | 'failed';
```

Every result carries `capabilityId`, `version`, `runId`, `steps: StepReport[]`,
`recoveries: RecoveryReport[]`, `degradedSteps`, and `evidence { runId,
directory, log, screenshots }`. Then, per status: `outputs` for `success`;
`outcomeId` plus its extracted fields for `business_outcome`; the intervention
and its resolution for `escalated`; `failure { class, stepId, detail, … }` for
`failed`.

```
StepReport.status: 'ok' | 'skipped' | 'recovered' | 'failed'
```

`recovered` is distinct from `ok` because a run full of recoveries succeeded and
is also telling you something is wrong with the app.

## 10. Policy

One `PolicyEngine` serves three actors:

```ts
type Actor = 'discovery-agent' | 'replay' | 'operator';
```

### 10.1 `classify(req) → Risk`

Risk comes from the control's **label**, matched against regex sets:

- **Irreversible** — `confirm`, `post`, `submit`, `transfer`, `wire`,
  `disburse`, `delete`, `remove`, `close account`, `approve`, `void`,
  `reverse`/`reversal`, `charge off`, `waive`
- **Reversible write** — `save`, `update`, `create`, `add`, `open`, `apply`
- Otherwise **read-only**

Three judgements are encoded here and all three are deliberate:

- **`fill` and `select` are read-only.** Typing into a field changes nothing
  durable. The risk lives in the submit that follows, and classifying keystrokes
  as writes would make every form-filling step require approval while gating
  nothing real.
- **A bare `press` is a write but never a commit.** Enter might submit; it might
  also tab. Unknowable from the keystroke, so it is treated as a write and never
  as irreversible.
- **`Continue` is explicitly not an irreversible pattern.** On these screens it
  is a navigation verb far more often than a write, and including it would
  inflate the risk tier of read-only lookups without gating anything more.

The bias is toward over-classification: a false irreversible costs one
intervention, a false read-only posts a transaction.

### 10.2 `authorize(req) → PolicyDecision`

Checks, in order: URL parses; origin is allowlisted; path prefix is allowlisted;
action kind is allowlisted; step and time budgets are unspent; then risk. On
`irreversible` the configured `onIrreversible` applies — `escalate` (the
default) or `block`. Violations carry one of seven codes:
`origin-not-allowed`, `path-not-allowed`, `action-not-allowed`,
`irreversible-blocked`, `malformed-url`, `step-budget-exceeded`,
`time-budget-exceeded`.

Defaults: **empty** origin and path allowlists (deny by default — a policy that
was not configured permits nothing), 40 steps, 5 minutes,
`operatorMayCommit: true`.

### 10.3 Authority matrix

| | Read | Reversible write | Irreversible | Outside allowlist |
|---|---|---|---|---|
| Discovery agent | yes | yes | **escalates to a human** | blocked |
| Replay | yes | yes | only if the artifact is approved for it | blocked |
| Operator | yes | yes | yes, while holding the session | blocked |

The last column is the point: an operator is more trusted than the agent but not
unbounded. A human driving the live session still cannot navigate the automation
to an origin the policy does not allow.

### 10.4 `forCapability`

An artifact's `policy` block **narrows** the ambient policy and can never widen
it: allowlists intersect, budgets take the minimum, `requiresApproval` ORs. An
artifact cannot grant itself permission it was not deployed with.

## 11. Escalation and control transfer

### 11.1 `SessionControl`

```
cedeToOperator(interventionId)   automation → operator, token issued
returnToAutomation()             operator → automation, token revoked
assert(actor)                    throws unless `actor` is the current holder
```

Every action, from either actor, calls `assert` first. One holder, always. This
is what stops the agent retrying a step while a person is half-way through
fixing it by hand — the class of bug that makes a handoff worse than no handoff.

### 11.2 Intervention lifecycle

```
raise(reason, detail, context) → Promise<InterventionResolution>
  list() / get(id)
  claim(id, by)                  takes control; starts the lease
  heartbeat(id)                  extends it
  observeForOperator(id)         the same observe() the agent uses
  screenshotForOperator(id)
  operatorAct(id, request)       same authorize → act → record path
  resolve(id, resolution)        returns control, settles the promise
```

`raise()` is context-in, resolution-out and returns a promise. That signature is
the seam: today an in-process broker settles it; in production a durable queue
and a session host settle it. Nothing upstream changes.

`ResolutionAction` is `resume` (automation continues from the interrupted step),
`abort` (fail with the operator's note), or `outcome` (the operator judges the
situation to be a declared outcome and names its id).

### 11.3 The 12 stuck reasons

```
control-not-found     ambiguous-control      checkpoint-failed
unexpected-dialog     session-expired        permission-denied
irreversible-approval policy-blocked         model-requested-help
no-progress           budget-exhausted       app-error
```

`no-progress` is the interesting one: several actions in a row changed nothing
on screen. A model can loop confidently for a long time, so this is a
liveness check the model does not get a vote on. `model-requested-help` is the
opposite — the agent has a `request_help` tool and asking is a first-class
successful outcome of a discovery step, not a failure.

### 11.4 Operator actions are recorded identically

`operatorAct` records `{ at, kind, target, … }` and emits an `operator.action`
event with `actor: 'operator'`. Same log, same shape, same policy gate. An
auditor reading a run cannot tell agent steps from human steps by log *shape* —
only by the actor field, which is exactly the property an audit trail needs.

A defect here was worth the test: the operator's action `kind` was spread over
the event envelope and overwrote the event's own `kind`, so operator clicks
were logged as event kind `click` instead of `operator.action`. The recorder now
writes the envelope **last**, so no caller field can relabel an event.

## 12. Discovery and compilation

### 12.1 The agent loop

`src/discover/agent.ts` (~500 lines). Tools offered to the model: `click`,
`type`, `select`, `press`, `read`, `observe`, `declare_output`,
`request_help`, `finish`.

Each iteration: observe → render the observation as text → send it with the
screenshot → receive a tool call → resolve the descriptor → authorize → act →
append a trace entry. The model addresses controls by descriptor, never by
coordinate:

```
role|name#ordinal|row=…|section=…|frame=…
```

`findControl` parses that and resolves it through the same ladder replay uses,
which is why a discovery run that succeeds produces references that replay can
use. Per-action the trace records: the derived `ControlRef`, the tier it
resolved at, the model's stated intent, its stated expectation, the phase, any
recoveries that fired, and whether a human performed it.

Irreversible actions are routed to a human with the exact action the agent
wanted; the operator performs it in the same session and the trace entry is
marked `humanAssisted`. So the first recording of a commit flow is
human-performed by construction, and the artifact says so in its provenance.

### 12.2 The compiler

`compileCapability()` turns a trace into an artifact:

1. **Parameterise.** Any input value present in the goal spec becomes
   `{{param}}` wherever it appears in a typed value.
2. **Generalise conditions.** `generalizeText` replaces a parameter's value
   inside a checkpoint's text with `\S+` and marks the condition as a regex. A
   checkpoint recorded as `textPresent: "Member 10000 retrieved"` would only
   ever pass for member 10000; it becomes `Member \S+ retrieved`.
3. **Scrub references.** `scrubRef` cuts parameter values out of scope labels,
   for the same reason.
4. **Merge the app profile.** Its `outcomes`, `recoveries` and policy narrowing
   are merged in. This is how a capability knows about conditions the discovery
   run never happened to encounter.
5. **Shadow recoveries.** `recoveryShadowing` marks a step as covered by a
   recovery only when *both* the ref matches and that recovery's trigger was
   actually live at that moment. Ref match alone produced false positives.
6. **Derive risk** per step from the policy engine, and the capability's
   `riskTier` as the maximum over its steps.
7. **Emit** with a reviewer header, then compute `contentHash`.

Steps 2 and 3 are what make a single recording work for *any* input. Without
them an artifact is a recording of one run, not a capability.

## 13. Observability and redaction

### 13.1 The recorder

One directory per run: `run.jsonl`, per-step screenshots, frame snapshots on
failure, and the result contract as returned. 20 event kinds:

```
run.start  run.end  observe  model.decision
action.request  action.blocked  action.done  action.failed
checkpoint.pass  checkpoint.fail  outcome.detected  recovery.applied
escalation.raised  escalation.granted  escalation.resumed  operator.action
policy.violation  evidence.captured  artifact.written  note
```

Redaction is applied **inside `event()`**, not at call sites. A log statement
added a year from now is redacted because the recorder does it, not because its
author remembered to.

### 13.2 What is protected, and how

| Kind | Mechanism |
|---|---|
| Credentials | Never in an artifact; `{{secret:vault.key}}` is resolved at replay. Exact-match registry scrubs any resolved value from every event |
| Declared sensitive fields | Redacted by *declaration* — `pii`, `pii-id`, `account`, `secret` |
| Undeclared PII | Pattern backstop (for example the tax-ID shape `\d{3}-\d{2}-\d{4}`) |
| Screenshots | Captured with sensitive controls masked |

The exact-match registry matters more than it looks: a resolved secret is
scrubbed wherever it appears, including inside an error message the application
echoed back. One defect found here: an artifact *filename* matched the email
pattern and was being redacted, making evidence harder to read. The redactor is
now anchored so filenames survive.

## 14. Multi-tenancy

### 14.1 Tenant overrides

```yaml
tenantOverrides:
  - tenant: cu-northstar
    appVersion: "9.1"
    entryUrlTemplate: http://localhost:8199/
    nameAliases:                     # the common case
      Retrieve: Search
      REGULAR SHARE SAVINGS: REGULAR SAVINGS
    refPatches: []                   # surgical, per step
    disabledSteps: []                # a step this tenant does not need
    extraRecoveries: []              # a condition only this tenant has
    allowedOrigins: [http://localhost:8199]
```

`specializeForTenant` applies aliases through `mapAllRefs`, which walks *every*
reference in the artifact — steps, checkpoints, preconditions, outcome detection,
recovery triggers and recovery actions. Rewriting only step refs leaves
checkpoints pointing at the other tenant's labels, which fails in the most
confusing possible way: the action works and the verification does not.

Aliases rewrite control **names and scope labels** both, because a relabelled
column header is also a relabelled row scope.

### 14.2 App profiles

Runtime conditions that belong to the *application* live once per app and are
merged into every capability recorded against it. The reasoning: a discovery run
can only meet the conditions it happens to encounter, but "this app signs you
out after fifteen minutes" is true for all twenty of its capabilities. Putting
it in the profile means the first recording of the twenty-first capability
already handles it.

## 15. The catalog projection

`toolForCapability(cap)` projects an artifact into an agent-callable tool
definition: name from `id`, description from `title` + `summary`, JSON Schema
input from `params`, output shape from `returns`, and the enumerated `outcomes`
with their descriptions.

It reads `params`, `returns`, `outcomes` and nothing else. Steps are not
projected, so a calling agent binds to the contract and cannot couple itself to
the implementation. Re-recording a flow with entirely different steps leaves the
tool definition byte-identical.

## 16. Testing strategy

636 tests across 29 files. 100% statements, branches, functions and lines, with
the threshold enforced in `vitest.config.ts` and no `istanbul ignore` anywhere:

```ts
coverage: {
  provider: 'v8',
  include: ['src/**/*.ts'],
  thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
}
```

Three test doubles make that reachable without mocking anything interesting:

- **`tests/fake-driver.ts`** — a complete in-memory `SurfaceDriver` in ~130
  lines, driven by a declarative screen graph. That a fake implements the seam
  that cheaply is the evidence the seam is a real abstraction rather than a
  Playwright wrapper with extra steps.
- **`tests/dom-harness.ts`** — jsdom, so the in-page perception pass is unit
  tested against hand-written legacy markup: nested framesets, layout tables,
  data grids, unlabelled inputs, colour-only error banners.
- **`ScriptedPlanner`** — a fixed tool-call sequence, so the whole discovery
  pipeline runs offline and deterministically.

Coverage at 100% is a floor, not the argument. The argument is what the suite
found: **ten product defects**, each of which would have produced a wrong result
rather than a crash. Those are enumerated in [REPORT.md](../REPORT.md); the
structural ones appear in §8.2, §11.4 and §12.2 above.

## 17. Extension recipes

### 17.1 A new surface adapter (desktop)

1. Implement `SurfaceDriver` over UI Automation or AX. See
   [`src/surface/desktop/README.md`](../src/surface/desktop/README.md) for the
   mapping.
2. Map platform control types onto the 17 roles. Most map directly; anything
   that does not becomes `text`.
3. Implement `observe()` to flatten the control tree into `Control`s. The naming
   cascade mostly disappears: UI Automation supplies `Name` directly, so the
   sources collapse to the equivalent of `aria-label`.
4. Map scope: `frame` → window or pane; `section` → group or tab item;
   `rowContaining` → grid row by cell content.
5. `hints.selector` has no meaning; leave it unset, so tier 5 is simply
   unavailable and the ladder skips it.
6. Run the shared driver conformance tests.

Nothing above the seam changes. The artifact schema, the ladder, the engine, the
policy gate and the console are all already surface-neutral.

### 17.2 A new app

1. Write an app profile: id, vendor, surface, secrets, and the app-level
   `outcomes` and `recoveries` (session expiry, maintenance interstitials,
   abend screens).
2. Configure its origin allowlist.
3. Run discovery for the first capability. The profile's conditions are merged
   in automatically.

### 17.3 A new tenant on an existing app

1. Add a `tenantOverrides` entry with `entryUrlTemplate` and `allowedOrigins`.
2. Replay an existing capability with `--tenant` and `--lenient-tenant`.
3. Read the `degradedSteps` report. Each degraded step names a control whose
   label moved — add it to `nameAliases`.
4. Repeat until clean, then remove the lenient flag.

The common case is a handful of label aliases. A tenant needing `refPatches` on
many steps is a signal it is a genuinely different flow and wants its own
capability.

### 17.4 A new condition kind

Add the variant to the union in `src/surface/types.ts`, the Zod schema in
`src/artifact/schema.ts`, and the evaluator. The compiler-exhaustive switch means
a missing case does not compile. It is then immediately available to
checkpoints, preconditions, outcome detection and recovery triggers — one
implementation, four uses.
