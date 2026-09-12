# Handspan — design write-up

A system that lets an LLM work out how a task is done inside a legacy
back-office banking application, records that as a reusable capability, and then
executes it deterministically with no model in the loop.

The through-line: **the model discovers, the artifact is the capability,
deterministic replay is how an agent invokes it.**

---

## 1. Architecture

Six layers, with one hard seam and one soft one.

```
                       capability catalog  (agent-facing: name + typed args)
                                │
        ┌───────────────────────┴───────────────────────┐
        │                                               │
  discovery (LLM)                                 replay (no LLM)
  observe → decide → act                          step → checkpoint → extract
        │                                               │
        └──────────────── policy engine ────────────────┘   ← every action, every actor
                                │
                     surface seam: SurfaceDriver
                                │
              web (Playwright)  │  desktop (not built)
                                │
                     escalation broker + operator console
```

**The hard seam is `SurfaceDriver`** ([src/surface/types.ts](src/surface/types.ts)).
Everything above it is written in terms of *named controls* — role, accessible
name, scope — and knows nothing about CSS, frames, window handles or UI
Automation. An adapter owes three things: `observe()` to flatten what it can see
into named controls, `resolve()` to turn a durable reference back into a live
control while reporting how confidently it did so, and the act/read methods.
That the replay engine's test suite drives an in-memory implementation of this
interface ([tests/fake-driver.ts](tests/fake-driver.ts), ~130 lines) is the
evidence the seam is real.

**The soft seam is the planner** ([src/llm/planner.ts](src/llm/planner.ts)):
hand it tool results, get back tool calls. Two implementations ship — Anthropic,
and a scripted one that replays a fixed call sequence. The scripted planner is
not a stub: the whole discovery pipeline (perception, guardrail, escalation,
recorder, compiler) runs through it offline and deterministically, which is how
discovery is tested at all.

### Decisions worth defending

**Controls, not coordinates.** The model gets a screenshot *and* a list of named
controls, and may only act on the latter. Vision matters — a dense 2003-era
servicing screen is far easier to reason about visually than as a flat list —
but a coordinate is not a durable locator, so an agent that clicks coordinates
produces nothing replayable. Constraining the action space to identified
controls means every action is *inherently* recordable. This is the single
decision most of the rest follows from.

**Perception synthesizes accessible names rather than trusting the platform's.**
On these surfaces the browser's accessibility tree is largely empty:
`<input name="mbr_no">` sits in a `<td>` with the words "Member Number" in the
`<td>` next door, and Chromium computes no name for it. So
[extract.ts](src/surface/web/extract.ts) runs a naming cascade that starts with
the signals the AX algorithm uses (`aria-label`, `aria-labelledby`, `label/for`,
wrapping label) and continues into the layout-derived ones legacy markup
actually carries: the adjacent table cell, the column header, then preceding
inline text. Without this, `role + name` is not a usable primary locator on the
target class of application, and the whole locator strategy collapses to CSS.
Table cells are first-class targets for the same reason — reading a value out of
a grid *is* the canonical back-office read.

**One policy gate, three actors.** The model's actions, replay's actions, and a
human operator's actions all go through `PolicyEngine.authorize`
([src/policy/policy.ts](src/policy/policy.ts)) and land in the same run log in
the same shape. There is no side door to the browser. This falls out of the
design rather than being bolted on, and it buys the audit trail, the origin
allowlist applying to humans, and "record what the human did" for free.

**Public contract declared by a person, not the model.** A goal spec
([config/goals/](config/goals/)) declares the capability's id, summary,
parameters, return values and their data sensitivity. The model works out the
screens. Two reasons: the interface an AI agent binds to is a design decision
with compliance consequences and is cheap for a human to write; and because the
parameter *values* are supplied, the compiler can distinguish a value the model
typed because the goal gave it one (parameterize) from one the screen demanded
(keep literal).

**One process, in-memory broker.** No queue, no session-host service, no
database. The operator console runs inside the run that owns the browser. That
is the honest boundary for a focused effort, and §5 says what production needs
instead — but the interface it would sit behind (`raise(context) → resolution`)
does not change.

### Trade-offs taken

| Chose | Over | Because |
|---|---|---|
| Playwright | Selenium, a CUA SDK | Frame handling, CDP access for operator attach, and a real browser context we can hand to a human |
| Hand-written naming cascade | CDP `Accessibility.getFullAXTree` | The AX name is empty on exactly the surfaces this targets. The output shape is the same either way, so swapping in CDP as tiers 1–4 is a contained change |
| Stamping `data-hs-h` on elements at observe time | CDP backend node ids | Robust across frames, cheap, and the attribute is cleared each observation. It does mutate the page, which is a real cost |
| YAML artifacts | JSON | The artifact is the review unit. Nested conditions are legible in YAML and are not in JSON |
| Re-perceive before every action | Cache the observation | Every interaction on these screens replaces the document, so a cached handle is stale more often than not. Costs tens of milliseconds; removes a class of flake |

---

## 2. Artifact schema

[src/artifact/schema.ts](src/artifact/schema.ts), Zod, serialized as YAML. A
worked example is in [evidence/](evidence/).

It has three readers, and the shape is a compromise between them: a **calling
agent** needs a description, a typed input signature, a typed output signature
and an enumerated set of outcomes; a **replay engine** needs ordered steps with
durable targets and per-step success conditions; a **human reviewer** has to be
able to approve it for unattended execution against a production core in a few
minutes.

```yaml
apiVersion: handspan.dev/capability/v1
id: meridian.member.savings_balance      # stable across versions; agents invoke by this
version: 1.0.0
title / summary                           # summary is what the agent's tool description says
surface: web-legacy
app: { id, vendor, vendorVersion, recordedForTenant }
entryUrlTemplate: "{{baseUrl}}/"

params:                                   # the public input signature
  memberId: { type: string, pattern: '^\d{5}$', required: true, sensitivity: pii-id }
returns:                                  # the public output signature
  savingsBalance: { type: money, sensitivity: account }
secrets: [meridian.password]               # vault keys. never values

steps:                                     # the implementation
  - id: s004
    intent: retrieve the member record     # written for the reviewer
    action: click
    phase: input                           # signon | navigate | input | commit | read
    risk: read_only
    ref: { role: button, name: Retrieve, scope: { frame: { name: main } } }
    checkpoint: { kind: textPresent, text: 'MEMBER DETAIL - \S+', regex: true }
    recordedTier: role+name+scope          # the drift baseline
    onCheckpointFail: fail

outcomes:                                  # named non-success results
  - id: MEMBER_NOT_FOUND
    detect: { kind: textPresent, text: 'No member found for' }
    disposition: return                    # return | escalate
    extract: [ { as: searchedFor, source: { kind: text, pattern: 'for (\d+)' } } ]

recoveries:                                # bounded responses to transient conditions
  - id: reauthenticate-expired-session
    when: { kind: textPresent, text: 'session has expired' }
    do: [ { kind: navigate, url: '{{baseUrl}}/' }, { kind: replayFrom, phase: signon } ]
    maxPerRun: 2

policy: { riskTier, allowedOrigins, allowedPathPrefixes, allowedActions, requiresApproval }
provenance: { discoveredBy, approval: { state, contentHash }, stability: { runs, successes } }
tenantOverrides: [ { tenant, nameAliases, refPatches, disabledSteps } ]
contentHash: 9f2c…
```

### Why it is shaped this way

**Contract and implementation are separated.** `params` / `returns` / `outcomes`
are the interface; `steps` is how it is achieved. An agent binds to the former
and never reads the latter. The catalog projection
([src/catalog/tools.ts](src/catalog/tools.ts)) is a pure function of the
contract half — nobody hand-writes a tool schema, so it cannot drift.

**Every step carries its own checkpoint.** The artifact is not "a list of
clicks" but "a list of clicks and what each one should have achieved". This is
what lets replay fail loudly at the right step instead of drifting silently to
the wrong screen and reporting a confident wrong answer. The linter warns about
any mutating step that lacks one.

**Business outcomes are declared data, not exceptions.** Each has a stable
SCREAMING_SNAKE id, a detector, and a disposition. "No such member" is returned
as an answer; an entitlement denial is routed to a human, because a person with
the right entitlement can complete the work and a retry never will. Conflating
these with failures is the mistake the brief warns about, and it is not merely
untidy — a calling agent that cannot tell "this member does not exist" from "the
automation is broken" will either retry forever or tell a member their account is
missing when a selector moved.

**Nothing in the file is a value.** Inputs are `{{templates}}`, credentials are
`{{secret:vault.key}}` references resolved at action time. An artifact is safe to
commit and safe to show a reviewer. The linter fails any literal matching a
regulated-data pattern, which catches a discovery run that baked in a real value.

**How a control is identified** — the focal point. A `ControlRef` is
`role + name + scope{frame, section, rowContaining} + ordinal`, with
surface-specific `hints` demoted to a lower tier. Role and name exist on a web
DOM, a 2003 frameset, and a Win32 window read through UI Automation, and they are
what survives a vendor point release. The recorder
([`deriveRef`](src/surface/match.ts)) deliberately records the *least* specific
ref that is unambiguous against everything else that was on screen: over-scoping
is what makes recordings brittle, and pinning a button to a heading that happens
to contain a member number breaks on the next member.

Two cases needed real thought:

- *Grid cells.* `{role: cell, name: Balance, scope: {rowContaining: REGULAR SHARE SAVINGS}}`
  is durable; scoping by ordinal is not, because which row the savings account
  occupies depends on what products the member holds. And the raw row text
  contains the balance we are trying to read, so the recorder derives a row
  *label* from the row's word-shaped cells instead. The distinction is available
  because perception records whether a cell was named by a column header (a data
  grid) or by an adjacent label (a layout table).
- *Layout cells.* No usable row label exists, so these fall back to an ordinal
  within the tightest scope — sound here precisely because these UIs change
  slowly, and safe because `recordedTier` makes any change visible.

**`phase` exists for one reason.** Session expiry is the most common runtime
condition in these systems, and recovering from it is not "sign on again" — it is
"sign on again, re-navigate, re-enter what was typed, then retry what failed".
`replayFrom: signon` expresses that in one line instead of duplicating the
prefix of the flow inside the recovery.

**Approval is pinned to a hash.** `contentHash` covers behaviour but not
provenance, so recording a replay result does not invalidate an approval while
editing a step does. `provenance.approval.contentHash` records what was
reviewed; if it no longer matches, unattended replay is refused. Without this,
approval is decorative.

---

## 3. Determinism & error handling

### Determinism

Replay ([src/replay/engine.ts](src/replay/engine.ts)) consults no model. Every
decision is a lookup in the artifact or an evaluation of a declared condition.
Four mechanisms carry it:

1. **The locator ladder.** Six tiers, best first: `role+name+scope`,
   `role+name+frame`, `role+name`, `role+nearText` (label association),
   `hint-selector`, `role+ordinal`. The first tier that identifies exactly one
   control wins. **Two matches and no ordinal is an error, not a guess** —
   silently taking the first of two "Confirm" buttons is how automation posts the
   wrong transaction.
2. **Condition polling, not sleeps.** One evaluator
   ([conditions.ts](src/replay/conditions.ts)) serves checkpoints, outcome
   detection and recovery triggers, so all three ask the same question against
   the same observation and cannot disagree about what is on screen. Each step
   polls its checkpoint until it holds or the step's budget expires, so transient
   slowness costs latency, not a failure. `urlMatches` matches *any* frame,
   because in a frameset the address bar never changes.
3. **A settle heuristic under that.** A click resolves as soon as the event is
   dispatched, before the browser has issued the request, so the driver watches
   for the navigation the action caused. This is best-effort; the engine's
   polling is the guarantee.
4. **Typed inputs validated before the browser opens.** A member number that
   fails its declared pattern is rejected as `invalid_input`. If it reached the
   screen it would come back as an application validation error — indistinguishable
   from a genuine one — and a caller bug would be reported as a business outcome.

### The step loop, and why the order matters

```
observe → apply any recovery whose trigger holds → wait for precondition
        → authorize → act → re-check the allowlist → detect outcomes
        → wait for checkpoint → extract
```

**Outcomes are checked before checkpoints.** When a search returns "no member
found", the checkpoint "the member detail screen is showing" is *also* false.
Whichever is evaluated first decides whether the caller learns a fact about the
member or a fact about the automation. Checking outcomes first means they learn
the former.

**The allowlist is re-checked after every action**, not only before navigations.
A click is an intent to move somewhere the pre-check cannot see, so the only
honest check is the one that looks at where the session actually ended up.

### The taxonomy

The result contract ([src/replay/result.ts](src/replay/result.ts)) is four-way:

| Status | Meaning | Example |
|---|---|---|
| `success` | Completed; typed outputs returned | `{ savingsBalance: 4182.55 }` |
| `business_outcome` | Completed; the answer is a named non-success | `MEMBER_NOT_FOUND` with `searchedFor` |
| `escalated` | A human was brought in; who holds it and why | entitlement denial, transaction abend |
| `failed` | Automation or application is wrong, with debug detail | `checkpoint_failed` at `s004` |

**Recoverable conditions are deliberately not a status.** A dismissed
interstitial or a re-authenticated session is an implementation detail of a
successful run. It appears in `recoveries` for observability and changes nothing
about what the caller does next. Recoveries are the only place replay may do
something the step list did not ask for; each is capped per run, and one never
nests inside another, so no loop can form.

`failed` carries a classified `class` — `invalid_input`, `not_approved`,
`invalid_artifact`, `target_not_found`, `ambiguous_target`, `checkpoint_failed`,
`precondition_failed`, `session_expired`, `app_error`, `policy_blocked`,
`escalation_timeout`, `driver_error`, `budget_exhausted` — plus the step, what it
expected in plain language, what it observed, and paths to a screenshot and a
per-frame DOM snapshot. Enough to debug without re-running.

### Drift, secondarily

The brief is right that drift is not the main problem here, so it is handled as a
*signal* rather than a repair mechanism. Every step records the tier it resolved
at during discovery. If replay resolves it at a worse tier, the run still
succeeds and the step is reported in `degradedSteps`. That is the early warning
that a vendor release moved something, surfaced before it becomes a failure, and
it is also how a new tenant gets qualified: run the artifact, see which steps
degrade, write aliases for those.

---

## 4. Heterogeneity & multi-tenant

### Other surfaces

The seam is `SurfaceDriver`, and the artifact's targeting vocabulary was chosen
to be expressible on all three surfaces rather than to fit a DOM.

- **Legacy web** is what this implements. The work was not in Playwright; it was
  the naming cascade, frame-aware scoping, and treating table cells as targets.
- **Modern web** is strictly easier. `role + name` comes straight from the real
  AX tree, and the whole naming cascade becomes tier zero of it.
- **Desktop** implements the same interface over UI Automation (Windows) or
  AX (macOS). `Control.role` is already the intersection of ARIA roles and
  UIA ControlTypes; `name` is UIA `Name`; `framePath` becomes a window/pane path;
  `hints.selector` becomes `AutomationId`. The locator ladder and the entire
  replay engine are reused unchanged — they are pure functions over a control
  list. Coordinates would have broken this, which is the second reason the
  model was never given them.

What would *not* survive unchanged: `structureSnapshot` (HTML → control-tree
dump), the screenshot masking (locator-based → region-based), and the CDP
operator-attach path (→ RDP/screen share). All are adapter-local.

### Many tenants, one artifact

The scale fact is not "each tenant's app is different" but "hundreds of tenants
run the same vendor product with different labels and versions". So the artifact
is one shared recording plus per-tenant specialization
([`specializeForTenant`](src/artifact/tenant.ts)):

- **`nameAliases`** — a label map applied to every ref in the artifact at once:
  control names *and* the section and row labels they are scoped by. One line
  covers a relabelled button for the whole flow. This is demonstrated end to end:
  one artifact recorded against `meridian-demo` (release 8.4) replays against
  `cu-northstar` (release 9.1, different branding, "Retrieve" → "Search",
  "REGULAR SHARE SAVINGS" → "REGULAR SAVINGS") via two alias lines.
- **`refPatches`** — per-step surgery for a control that genuinely moved rather
  than merely got renamed.
- **`disabledSteps` / `extraRecoveries`** — a screen this tenant does not show,
  or an interstitial only they have.
- **App-level conditions live in an app profile**
  ([config/apps/meridian.app.yaml](config/apps/meridian.app.yaml)), not in each
  capability. "This app signs you out after fifteen minutes and shows a red
  banner" is a fact about the application, true for all twenty capabilities
  recorded against it, and the compiler merges it in. A discovery run cannot
  learn it — the model will never see a session timeout in a ninety-second run —
  and writing it per capability means writing it hundreds of times per tenant and
  getting it subtly wrong each time.

**Unknown tenants fail closed.** Running a recording against a tenant with no
override throws rather than proceeding, because silently pointing a recorded flow
at a different institution's build is how you get a wrong posting.
`--lenient-tenant` relaxes it for qualification runs, where the tier-drift report
tells you which aliases to write.

**Detecting drift across the estate.** `provenance.stability` accumulates
runs/successes and the steps that last degraded. Replaying a capability across
tenants nightly and watching the degraded-step set is the cheap version of drift
monitoring, and it needs no extra machinery.

---

## 5. Escalation & handoff

[src/escalation/broker.ts](src/escalation/broker.ts). The design question is not
"how do we notify someone" — that is a queue — but "what does it mean for a human
to take over a session the automation is halfway through".

### Detecting stuck

Explicit and implicit. The model can call `request_help` at any point. The system
also raises an intervention on: a control that matched nothing at any tier; a ref
that matched several controls with no way to choose; a checkpoint that never held
on a step marked `onCheckpointFail: escalate`; an outcome whose disposition is
`escalate` (entitlement denial, transaction abend); a policy refusal of an
irreversible action; a step or time budget exhausted; and — during discovery —
several observations in a row showing an identical screen, which is what being
stuck actually looks like from the outside.

### Taking control

Three properties, and they are the whole answer.

**One session, one controller.** `SessionControl` is a token held by exactly one
actor. Automation holds it by default; raising an intervention cedes it. The
operator's actions are refused until they claim it, and the automation's are
refused until it is handed back — any action from a non-controller throws. This is
what prevents the failure mode where the agent retries a step while a person is
mid-way through fixing it by hand.

**One action pipeline, two actors.** The operator does not get a side door to the
browser. Their clicks go through the same `authorize → act → record` path with
`actor: 'operator'`. Two things fall out: every manual step lands in the same run
log in the same shape, and the origin allowlist still applies to a human. Their
*authority* is higher — an operator may commit an irreversible action the agent
may not — but their *boundary* is identical. A blocked operator action is logged
as blocked.

**A lease, not a promise.** A claim carries a heartbeat-extended lease. When it
lapses, control returns to the broker and the run fails with
`escalation_timeout` rather than hanging.

The console ([src/escalation/console.ts](src/escalation/console.ts)) shows the
intervention queue with the reason, the step, what was expected, what was
observed, what the operator is being asked to do, and a screenshot. Taking
control gives a live view of the same session — polled screenshots plus the live
perceived control list — with click / fill / select per control and a navigate
box. Everything it does calls the broker, which calls the same driver. When the
session was launched with `--debug-port`, the console also surfaces the CDP URL
so an operator can attach a full browser to the same page for free-form work;
actions taken that way are captured as before/after evidence rather than as
discrete records, which is an honest limitation of that path.

### Handing back

Three resolutions: **resume** (the engine re-observes, re-asserts the pending
step's checkpoint, and continues), **abort** (the run returns `escalated` with
the operator's note), or **declare a business outcome** (the operator judges it
`MEMBER_NOT_FOUND` and the caller gets that, with the human recorded as the
source). `intervention.operatorActions` records every action they took —
including its shape but never its value, since operators type credentials and
member data.

[`evidence/09-operator-takeover-and-resume/`](evidence/09-operator-takeover-and-resume/)
is a worked instance: a transaction abend mid-flow, the intervention routed with
the screenshot and the abend reference, an operator clearing the screen by hand
in the same session, a navigation outside the allowlist refused *to the human*,
control handed back, and the run completing with the correct outputs. Both
operator actions are in that run's `run.jsonl`, including the refused one.
[`evidence/07-discovery-subaccount-escalation/`](evidence/07-discovery-subaccount-escalation/)
is the approval variant, where the refused action is the posting itself.

Discovery uses the same path for approvals: the model reaches the confirmation
screen, policy refuses "Confirm and Post", a human performs it in the same
session, and the step is recorded as `humanAssisted` with
`onCheckpointFail: escalate`, because the step that needed a person once is the
one most likely to need one again. The resulting artifact carries an irreversible
step and therefore `requiresApproval: true`.

### What is mocked, and the seam

The broker is in-process, so the console runs inside the run that owns the
browser. Production needs a **session host** that outlives the process — the
browser (or desktop VM) lives in the host, sessions are addressable by id, and
both the automation and the console attach as clients — plus a durable queue in
front of `raise()` with routing and SLAs. The `raise(reason, detail, context) →
resolution` interface does not change; `SessionControl`'s invariants become the
host's. The standalone `npm run operator` exists to look at the console and has
no session to hand over, which is exactly this limitation made visible.

---

## 6. Safety

Layered, and each layer assumes the one above it can be wrong.

**Where.** An origin and path-prefix allowlist, deny by default
([config/policy.yaml](config/policy.yaml)). Checked on navigation and again after
every action. An artifact may *narrow* the deployment's allowlist and can never
widen it: an artifact naming an origin the deployment does not permit ends up
with no permitted origins and fails closed.

**What.** Action kinds are allowlisted. Each action is classified into
`read_only` / `reversible_write` / `irreversible` from the control's accessible
name — the same signal a human uses, since a button saying "Confirm and Post" is
doing something one saying "Retrieve" is not. The classifier is tuned to
**over**-classify: a needless confirmation costs seconds, the opposite mistake
posts money. Typing and selecting are `read_only` because they change nothing on
the server; all the risk in a legacy flow sits in the control that submits. A
bare `Enter` is treated as a write, since the default submit cannot be named.

**Risk is per step, not per capability**, because these flows are a long
read-only prefix followed by one commit. Gating the whole capability on its worst
step would make every read require approval.

**Who.** Three actors, one gate. Discovery routes an irreversible action to a
human by default. Replay's authority comes from the artifact's approval state,
checked before the run starts, and an unapproved artifact that requires approval
is refused with `not_approved`. Operators may commit; the deployment can turn
that off.

**Secrets.** The model is never shown a credential. It calls `type_secret` with a
*vault key*; the value is fetched and typed by the system. The artifact stores
`{{secret:meridian.password}}`, never a value. Resolved secrets are registered
with the run's redactor, so if one ever reaches a log line or a DOM snapshot it
is scrubbed literally on the way out.

**Regulated data.** Two mechanisms, deliberately separate. *Declared
sensitivity* on every parameter and return (`pii`, `pii-id`, `account`,
`secret`) is the real protection: an extracted value is returned to the caller
but the log records only `«account»`, and an identifier is logged as a stable
non-reversible fingerprint so two runs on the same member can be correlated
during debugging without the id being written down. *Pattern redaction* (tax
ids, card numbers, emails, tokens, long account-shaped digit runs) is a backstop
applied inside the recorder rather than at call sites, so a log statement added
later cannot leak by forgetting. Artifacts never contain concrete values, and the
linter fails any literal that looks like regulated data.

Screenshots mask controls the policy flagged sensitive before encoding.

### Limits, stated plainly

- **Pattern redaction cannot recognize a name, an address or a balance.** That is
  why declared sensitivity exists, and why a capability whose returns are
  mis-classified will leak into logs. It is a human review step with no automated
  backstop.
- **Screenshot masking only covers controls we can identify.** Sensitive data
  rendered as free text in a paragraph is still in the PNG. Evidence capture is
  therefore as sensitive as the data the flow touches and needs the same handling.
- **Risk classification is a label heuristic.** A button labelled "OK" that posts
  a wire is classified `read_only`. The mitigation is the per-app override list
  and human approval for anything a discovery run had to escalate — not the
  classifier.
- **The origin allowlist does not stop harm inside the allowed origin.** An
  approved artifact with a wrong step will do the wrong thing to the right
  application. Checkpoints and approval are the defence; the allowlist only
  bounds the blast radius.
- **`data-hs-h` mutates the page.** Non-visual, cleared every observation, gone on
  navigation — but it is a write to a production application's DOM, and a
  reviewer at a bank would reasonably ask about it. CDP backend node ids avoid it.
- **Nothing here is a tamper-proof audit log.** Evidence is files on disk; a real
  deployment needs append-only storage with retention rules.

---

## 7. Cuts

### Cut deliberately

- **A durable queue and a cross-process session host.** The single highest-value
  thing not built, and §5 describes the seam it sits behind. Everything else in
  escalation is real.
- **Streaming co-browsing.** The console polls screenshots. Correct control
  transfer semantics mattered; frame rate did not.
- **A desktop adapter.** The seam is exercised by two implementations (Playwright,
  in-memory) rather than three. §4 is a design answer, not a built one.
- **Assisted LLM recovery on replay failure.** Attractive and dangerous. A bounded
  single-step recovery would need its own policy story, and I would rather
  escalate to a person than reason about a half-completed posting.
- **Multi-tenant plumbing.** One shared artifact with overrides, demonstrated
  across two tenants. No tenant registry, no per-tenant credential store.
- **Auth on the operator console.** It is a localhost development surface. In
  production it is the most security-sensitive component in the system.

### The one thing outstanding

**The committed evidence was produced with the scripted planner, not a live
model.** No model credential was available in the environment this was built in,
and I did not go looking for one. Everything the model would drive is real and
exercised — perception, the policy gate, the escalation handoff, the compiler,
replay — and the scripted planner issues exactly the same tool calls through
exactly the same pipeline, so the artifacts in `evidence/` are the artifacts the
model path produces. But the brief is explicit that the discovery run has to be
a genuine one, and I am not going to imply that it was.

To produce it, set `ANTHROPIC_API_KEY` and drop the `--script` flag:

```bash
npm run discover -- config/goals/member-savings-balance.goal.yaml
```

That is a single run against a local app, so it costs very little. The run
directory it writes under `evidence/runs/` has the model's reasoning in
`run.jsonl` alongside every action, which is the part the scripted evidence
cannot show.

### What the test suite is, and what it found

636 tests, and 100% of statements, branches, functions and lines across `src/`
with no exclusions — `npm run coverage` fails below that. The number matters
less than the two structural changes needed to reach it honestly, both of which
are better design:

- **The in-page perception pass is driven under jsdom as well as in Chromium.**
  It normally executes inside the browser, where Node's instrumentation cannot
  see it, so its 400 lines of naming cascade were effectively unmeasured. jsdom
  supplies a real style cascade; the harness supplies the two things jsdom does
  not implement (`getBoundingClientRect`, `CSS.escape`) rather than stubbing the
  code under test. The Playwright test stays as the check that it holds in a
  real browser.
- **Every command became a function of `(argv, io, sessionFactory)` returning an
  exit code**, with the only `process.argv` read and `process.exit` call in
  `bin/handspan.ts`, which has no logic. That removed the CLI layer's hard
  dependency on Playwright as a side effect.

Where a branch turned out to be unreachable defensive code — a `??` on a value a
schema already guarantees — the defence was deleted rather than hidden behind a
coverage exclusion.

Eleven real defects surfaced while writing the tests, which is the actual argument
for having done it:

| Defect | Why it mattered |
|---|---|
| An extraction was attempted on a *skipped* optional step | Turned a correctly skipped step into a hard failure |
| After a recovery rebuilt the flow, the checkpoint was re-checked without re-running the step | Session-expiry recovery could never succeed mid-flow |
| A keystroke with no focused control tried to resolve an undefined reference | Any unfocused `press_key` crashed the discovery loop |
| The operator's action kind overwrote the *event* kind in the run log | Every manual step appeared as a bare `click`, losing the audit trail |
| The console labelled an error response as a PNG | A refusal reached the operator as a broken image, not a reason |
| The console reported the port it was asked for, not the one it bound | Port 0 (pick a free one) produced an unusable URL |
| Port 0 was treated as "no port given" throughout the session wiring | Same class of bug, three places |
| The demo's failure counter was module-level | A second run in one process inherited the first run's failures |
| `money` and `number` transforms returned 0 for a cell with no digits | A balance silently read as zero, the worst possible extraction failure |
| An artifact filename was mistaken for an email address by the redactor | Evidence paths were logged as `capabilities/«email»` |
| An invalid `ANTHROPIC_API_KEY` crashed `discover` with a raw SDK stack trace | The README says `cp .env.example .env`, whose placeholder key passed the presence check and 401'd; the fallback probe then logged the auth error as a missing beta and retried it |

### Known rough edges

- Recoveries are matched in declaration order with no priority; two triggers true
  at once resolve arbitrarily but deterministically.
- A recovery's `maxPerRun` is shared between the proactive check before a step
  and the failure paths after it, so a budget of 1 is usually spent before the
  step runs. Correct, but surprising when writing one.
- The `assert`-only final step exists so the overall success condition is visible
  in one place, which means the last screen is checked twice — once by the
  preceding step's checkpoint and once by the assert.
- The operator console polls a PNG every two seconds. It is usable; it is not
  pleasant on a slow flow.

### What I would build next, in order

1. **The session host.** Sessions that outlive the process, addressable by id,
   with the console as a peer client rather than a co-resident. Unblocks real
   operator workflows and makes the handoff production-shaped.
2. **Nightly stability replay across tenants**, feeding `provenance.stability`
   and the degraded-step set. Turns tier drift from a per-run curiosity into
   estate-wide drift monitoring, and it is nearly free given what already exists.
3. **A desktop adapter over UI Automation.** The interesting test of the seam, and
   the thing that would prove the targeting vocabulary generalizes rather than
   merely being designed to.
4. **Review tooling on the artifact.** A diff view between versions that
   highlights changed steps and checkpoints, since the approval model already
   pins a hash and a reviewer currently reads raw YAML.
