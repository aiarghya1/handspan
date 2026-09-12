# Handspan — design write-up

An LLM works out how a task is done inside a legacy back-office banking
application, the run is recorded as a reusable capability, and that capability
then executes deterministically with no model in the loop. **The model
discovers, the artifact is the capability, deterministic replay is how an agent
invokes it.** This is the argument; the detail is in [docs/HLD.md](docs/HLD.md)
and [docs/LLD.md](docs/LLD.md).

---

## 1. Architecture

```
                    capability catalog  (agent-facing: name + typed args)
     ┌──────────────────────┴──────────────────────┐
  discovery (LLM)                            replay (no LLM)
  observe → decide → act                     step → checkpoint → extract
     └───────────── policy engine ───────────┘  ← every action, every actor
                surface seam: SurfaceDriver
          web (Playwright)  │  desktop (not built)
                escalation broker + operator console
```

**The hard seam is `SurfaceDriver`** ([types.ts](src/surface/types.ts)).
Everything above it speaks in *named controls* — role, accessible name, scope —
and knows nothing about CSS, frames or UI Automation. The replay test suite
drives an in-memory implementation of it ([fake-driver.ts](tests/fake-driver.ts)),
which is the evidence the seam is real rather than aspirational.

**Controls, not coordinates.** The model gets a screenshot *and* a list of named
controls, and may act only on the latter. Vision matters on a dense 2003-era
screen, but a coordinate is not a durable locator, so constraining the action
space to identified controls is what makes every action *inherently* recordable.
Most of the design follows from this one decision.

**Perception synthesizes accessible names rather than trusting the platform's.**
Here the AX tree is largely empty: `<input name="mbr_no">` sits beside a `<td>`
reading "Member Number" and Chromium computes no name for it. So
[extract.ts](src/surface/web/extract.ts) runs a naming cascade from the AX
algorithm's signals into the layout-derived ones legacy markup carries — adjacent
cell, column header, preceding inline text. Without it, `role + name` is not a
usable primary locator here and the strategy collapses to CSS.

**One policy gate, three actors.** Model, replay and human operator all pass
`PolicyEngine.authorize` and land in the same run log in the same shape. There is
no side door to the browser, so the audit trail and the allowlist applying to
humans fall out rather than being bolted on.

| Chose | Over | Because |
|---|---|---|
| Playwright | Selenium, a CUA SDK | Frames, CDP for operator attach, a context we can hand a human |
| Naming cascade | CDP `getFullAXTree` | The AX name is empty on exactly these surfaces; same output shape, so swapping CDP in as tiers 1–4 stays contained |
| YAML | JSON | The artifact is the review unit; nested conditions are legible in YAML |
| In-memory broker | Session host and queue | The honest boundary for a focused effort; §5 has the seam |

---

## 2. Artifact schema

[schema.ts](src/artifact/schema.ts), Zod, serialized as YAML; worked example in
[evidence/capability/](evidence/capability/). It has three readers and its shape
is a compromise between them: an **agent** needs typed inputs, typed outputs and
enumerated outcomes; a **replay engine** needs ordered steps with durable targets
and per-step success conditions; a **reviewer** must be able to approve it for
unattended execution against a production core in minutes.

```yaml
id / version / title / summary / surface / app / entryUrlTemplate
params:   memberId: { type: string, pattern: '^\d{5}$', sensitivity: pii-id }
returns:  savingsBalance: { type: money, sensitivity: account }
secrets:  [meridian.password]          # vault keys, never values
steps:    [ { id, intent, action, phase, risk, ref, checkpoint, recordedTier } ]
outcomes: [ { id, detect, disposition: return|escalate, extract } ]
recoveries: [ { id, when, do, maxPerRun } ]
policy / provenance / tenantOverrides / contentHash
```

**Contract and implementation are separated.** `params`, `returns` and `outcomes`
are the interface; `steps` is how it is achieved. An agent binds to the former
and never reads the latter, and the catalog projection is a pure function of the
contract half, so no tool schema is hand-written and none can drift.

**Every step carries its own checkpoint,** so the artifact is not "a list of
clicks" but "a list of clicks and what each should have achieved". That is what
lets replay fail loudly at the right step instead of drifting to the wrong screen
and returning a confident wrong answer.

**Business outcomes are declared data, not exceptions** — each with a stable id,
a detector and a disposition. "No such member" is returned as an answer; an
entitlement denial is routed to a human, because a person with the right
entitlement can complete the work and a retry never will. **Nothing in the file
is a value**: inputs are `{{templates}}`, credentials are `{{secret:vault.key}}`
resolved at action time, and the linter fails any literal that looks regulated.

**How a control is identified** is the focal point. A `ControlRef` is
`role + name + scope{frame, section, rowContaining} + ordinal`, with
surface-specific `hints` demoted to a lower tier — role and name exist on a modern
DOM, a 2003 frameset and a Win32 window read through UI Automation, and survive a
vendor point release. The recorder records the *least* specific ref that is
unambiguous against everything else on screen, because over-scoping is what makes
recordings brittle: pinning a button to a heading containing a member number
breaks on the next member.

Two smaller decisions carry weight. **`phase`** exists because recovering from
session expiry is not "sign on again" but "sign on again, re-navigate, re-enter
what was typed, retry what failed", which `replayFrom: signon` says in one line.
And **approval is pinned to a content hash** covering behaviour but not
provenance, so recording a replay result does not invalidate an approval while
editing a step does. Without that, approval is decorative.

---

## 3. Determinism & error handling

Replay ([engine.ts](src/replay/engine.ts)) consults no model. Every decision is a
lookup in the artifact or an evaluation of a declared condition.

**The locator ladder.** Six tiers, best first: `role+name+scope`,
`role+name+frame`, `role+name`, `role+nearText`, `hint-selector`, `role+ordinal`.
The first tier identifying exactly one control wins. **Two matches and no ordinal
is an error, not a guess** — silently taking the first of two "Confirm" buttons is
how automation posts the wrong transaction.

**Condition polling, not sleeps.** One evaluator serves checkpoints, outcome
detection and recovery triggers, so all three ask the same question against the
same observation and cannot disagree about what is on screen; transient slowness
costs latency, not a failure. **Typed inputs are validated before the browser
opens**, because a bad member number reaching the screen comes back as an
application validation error indistinguishable from a genuine one, turning a
caller bug into a reported business outcome.

```
observe → apply any recovery whose trigger holds → wait for precondition
        → authorize → act → re-check the allowlist → detect outcomes
        → wait for checkpoint → extract
```

**Outcomes are checked before checkpoints.** When a search returns "no member
found", the checkpoint "the member detail screen is showing" is *also* false.
Whichever is evaluated first decides whether the caller learns a fact about the
member or a fact about the automation. **The allowlist is re-checked after every
action**, because a click is an intent to move somewhere the pre-check cannot see.

| Status | Meaning | Example |
|---|---|---|
| `success` | Completed; typed outputs returned | `{ savingsBalance: 4182.55 }` |
| `business_outcome` | Completed; the answer is a named non-success | `MEMBER_NOT_FOUND` with `searchedFor` |
| `escalated` | A human was brought in; who holds it and why | entitlement denial, abend |
| `failed` | Automation or application is wrong, with debug detail | `checkpoint_failed` at `s004` |

**Recoverable conditions are deliberately not a status.** A dismissed interstitial
or a re-authenticated session is an implementation detail of a successful run; it
appears in `recoveries` for observability and changes nothing about what the
caller does next. Recoveries are the only place replay may do something the step
list did not ask for, so each is capped per run and none nests. `failed` carries
one of thirteen classified `class` values plus the step, what it expected in plain
language, what it observed, and paths to a screenshot and a DOM snapshot.

**Drift is a signal, not a repair mechanism.** Every step records the tier it
resolved at during discovery; resolving worse on replay still succeeds but reports
the step in `degradedSteps`.

---

## 4. Heterogeneity & multi-tenant

**Other surfaces.** The targeting vocabulary was chosen to be expressible on all
three rather than to fit a DOM. Modern web is strictly easier: `role + name` comes
from the real AX tree and the naming cascade becomes tier zero of it. Desktop
implements the same interface over UI Automation or AX — `Control.role` is already
the intersection of ARIA roles and UIA ControlTypes, `framePath` becomes a window
path, `hints.selector` becomes `AutomationId` — and the locator ladder and replay
engine are reused unchanged, being pure functions over a control list. Coordinates
would have broken that, the second reason the model was never given them. Only the
structure snapshot, screenshot masking and CDP operator-attach would need
replacing, and all three are adapter-local.

**Many tenants, one artifact.** The scale fact is not "each tenant's app differs"
but "hundreds run the same vendor product with different labels and versions". So
an artifact is one shared recording plus per-tenant specialization: `nameAliases`
maps labels across every ref at once, including the section and row labels refs
are scoped by; `refPatches` is per-step surgery for a control that genuinely
moved; `disabledSteps` and `extraRecoveries` cover a screen a tenant lacks or an
interstitial only they have. Demonstrated end to end — one artifact recorded
against `meridian-demo` (release 8.4) replays unchanged against `cu-northstar`
(release 9.1, rebranded) on two alias lines.

**App-level conditions live in an app profile**, not each capability. "This app
signs you out after fifteen minutes" is true for all twenty capabilities recorded
against it, a discovery run cannot learn it — the model will never see a timeout
in a ninety-second run — and writing it per capability means writing it hundreds
of times per tenant and getting it subtly wrong each time.

**Unknown tenants fail closed**, because silently pointing a recorded flow at a
different institution's build is how you get a wrong posting. `--lenient-tenant`
relaxes that for qualification runs, where the tier-drift report tells you which
aliases to write. `provenance.stability` accumulates runs, successes and
last-degraded steps, so nightly cross-tenant replay is drift monitoring with no
extra machinery.

---

## 5. Escalation & handoff

The design question is not "how do we notify someone", which is a queue, but
"what does it mean for a human to take over a session the automation is halfway
through" ([broker.ts](src/escalation/broker.ts)).

**Detecting stuck.** The model can call `request_help`. The system also raises an
intervention on an unresolvable or ambiguous ref, a checkpoint that never held on
a step marked `onCheckpointFail: escalate`, an outcome whose disposition is
`escalate`, a policy refusal of an irreversible action, an exhausted budget, and —
during discovery — several observations in a row showing an identical screen,
which is what being stuck looks like from outside.

**One session, one controller.** `SessionControl` is a token held by exactly one
actor. Automation holds it by default and raising an intervention cedes it; the
operator's actions are refused until they claim it and the automation's until it
is handed back. This prevents the failure mode where the agent retries a step
while a person is mid-way through fixing it by hand. The claim carries a
heartbeat-extended lease, so an operator who closes their laptop does not wedge
the session — control returns to the broker and the run fails with
`escalation_timeout` rather than hanging.

**One action pipeline, two actors.** The operator gets no side door to the
browser. Their clicks take the same `authorize → act → record` path with
`actor: 'operator'`, so every manual step lands in the same run log in the same
shape and the origin allowlist still applies to a human. Their *authority* is
higher; their *boundary* is identical.

**Handing back** has three resolutions: **resume** (re-observe, re-assert the
pending checkpoint, continue), **abort** (return `escalated` with the note), or
**declare a business outcome** (the operator judges it `MEMBER_NOT_FOUND` and the
caller gets that, with the human recorded as the source). Operator actions are
recorded by shape, never by value, since operators type credentials and member
data. [`evidence/09-operator-takeover-and-resume/`](evidence/09-operator-takeover-and-resume/)
is a worked instance: an abend mid-flow, the intervention routed with the
screenshot and the abend reference, an operator clearing the screen by hand in the
same session, a navigation outside the allowlist refused *to the human*, control
handed back, and the run completing with correct outputs.

**The seam.** The broker is in-process, so the console runs inside the run that
owns the browser. Production needs a session host outliving the process, sessions
addressable by id, automation and console both attaching as clients, and a durable
queue in front of `raise()`. That interface does not change; `SessionControl`'s
invariants become the host's.

---

## 6. Safety

Layered, each layer assuming the one above it can be wrong.

**Where.** An origin and path-prefix allowlist, deny by default, checked on
navigation and again after every action. An artifact may *narrow* the
deployment's allowlist and can never widen it: one naming an origin the
deployment does not permit ends up with no permitted origins and fails closed.

**What.** Action kinds are allowlisted, and each action is classified
`read_only` / `reversible_write` / `irreversible` from the control's accessible
name, the same signal a human uses. The classifier is tuned to
**over**-classify: a needless confirmation costs seconds, the opposite mistake
posts money. Typing and selecting are `read_only` because they change nothing on
the server; all the risk sits in the control that submits. Risk is **per step,
not per capability**, because these flows are a long read-only prefix followed by
one commit, and gating on the worst step would make every read need approval.
Replay's authority comes from the artifact's approval state, checked before the
run starts.

**Data.** The model is never shown a credential — it calls `type_secret` with a
*vault key* and the system fetches and types the value, registering it with the
run's redactor so any leak is scrubbed literally on the way out. For regulated
data there are two separate mechanisms. *Declared sensitivity* on every parameter
and return is the real protection: an extracted value goes to the caller but the
log records only `«account»`, and an identifier is logged as a stable
non-reversible fingerprint, so two runs on the same member can be correlated
without the id being written down. *Pattern redaction* is a backstop applied
inside the recorder rather than at call sites, so a log statement added later
cannot leak by forgetting.

**Limits.** Pattern redaction cannot recognize a name, an address or a balance,
so a mis-classified return leaks with no automated backstop — declared sensitivity
is a human review step. Masking only covers controls we can identify, so free text
stays in the PNG and evidence is as sensitive as the data the flow touches. Risk
classification is a label heuristic: a button labelled "OK" that posts a wire is
`read_only`, and the mitigation is the per-app override list and human approval,
not the classifier. The allowlist bounds blast radius but does not stop an
approved artifact with a wrong step doing the wrong thing to the right
application. And evidence is files on disk, not a tamper-proof audit log.

---

## 7. Cuts

**Cut deliberately.** A durable queue and cross-process session host, the
highest-value thing not built, behind the seam §5 describes. Streaming
co-browsing, because control-transfer semantics mattered and frame rate did not.
A desktop adapter, so §4 is a design answer rather than a built one. Assisted LLM
recovery on replay failure — attractive and dangerous; I would rather escalate
than reason about a half-completed posting. Multi-tenant plumbing beyond
overrides. Auth on the operator console, in production the most
security-sensitive component here.

**The one thing outstanding.** *The committed evidence was produced with the
scripted planner, not a live model.* No model credential was available where this
was built. Everything the model would drive is real and exercised — perception,
the policy gate, the escalation handoff, the compiler, replay — and the scripted
planner issues the same tool calls through the same pipeline, so the artifacts in
`evidence/` are the artifacts the model path produces. But the brief is explicit
that the discovery run has to be genuine, and I am not going to imply that it
was. To produce it, set `ANTHROPIC_API_KEY` and run:

```bash
npm run discover -- config/goals/member-savings-balance.goal.yaml
npx tsx scripts/curate-evidence.ts
```

The curator prefers a model-driven discovery over a scripted one, so the second
command moves the genuine run into the committed evidence without disturbing the
slots it does not match.

**The test suite.** 636 tests, and 100% of statements, branches, functions and
lines across `src/` with no exclusions. The number matters less than the two
structural changes needed to reach it honestly, both better design: the in-page
perception pass is driven under jsdom as well as Chromium, so its naming cascade
is measured rather than executing invisibly inside the browser; and every command
became a function of `(argv, io, sessionFactory)` returning an exit code.
Unreachable defensive branches were deleted, not excluded. Eleven real defects
surfaced, the sharpest being that `money` transforms returned 0 for a cell with no
digits, so a balance could read as zero. Full list in [docs/LLD.md](docs/LLD.md).

**Next, in order:** the session host and durable queue, so escalation survives the
process; a desktop adapter, to prove the seam rather than argue for it; and
stability scoring driving the draft → approved gate automatically, since
`provenance.stability` already accumulates what it needs.

**Known rough edges.** Recoveries match in declaration order with no priority. The
tenant override model handles relabelling and small moves; a tenant whose flow
genuinely differs needs its own recording, and nothing detects that for you. The
console polls screenshots at a fixed interval, so a fast-changing screen looks
laggy to the human holding control.
