# Handspan

Record-once / replay-many computer use for legacy back-office banking applications.

An LLM drives a real application UI to work out how a task is done. The run is
recorded as a **capability artifact**: a typed, versioned, reviewable description
of the flow. After that the artifact replays deterministically, with no model in
the decision loop, and an AI agent invokes it by name with typed arguments.

```
goal + target ──▶ LLM discovery run ──▶ capability artifact ──▶ deterministic replay ──▶ typed result
                        │                      │                        │
                   policy gate            human review            policy gate
                        │                  + approval                   │
                        └──────────── human operator takes over the live session ───────┘
```

The design write-up is in [REPORT.md](REPORT.md). Worked evidence is in
[evidence/](evidence/). The system design is in [docs/HLD.md](docs/HLD.md)
(architecture, flows, trade-offs) and [docs/LLD.md](docs/LLD.md) (interfaces,
algorithms, invariants, extension recipes).

## What is here

| Path | What it is |
|---|---|
| `target-app/` | The stand-in for a bank back-office system: server-rendered, frameset, table layouts, no test IDs, injectable runtime faults |
| `src/surface/` | The surface seam. `types.ts` is the contract; `web/` implements it over Playwright; `match.ts` is the locator ladder |
| `src/artifact/` | The capability schema, the store, the linter, tenant specialization, app profiles |
| `src/discover/` | The LLM loop, and the compiler that turns a run into an artifact |
| `src/replay/` | The deterministic executor, the condition evaluator, the result contract |
| `src/policy/` | The guardrail every action passes through, and redaction |
| `src/escalation/` | Control transfer and the operator console |
| `src/catalog/` | The agent-facing projection of saved artifacts |
| `config/` | App profile, goal specs, deployment policy |

## Setup

Requires Node 20+.

```bash
npm install
npx playwright install chromium
npm run build
cp .env.example .env        # demo credentials for the mock app; no real secrets
```

Start the mock application. Two instances, standing in for two institutions
running the same vendor product at different releases:

```bash
npm run target-app          # tenant meridian-demo  -> http://localhost:8099  (release 8.4)
npm run target-app:v9       # tenant cu-northstar   -> http://localhost:8199  (release 9.1)
```

Sign-on is `tellersvc` / `demo-pass-not-real`. Members on file: `12345`,
`23456`, `34567`, and `77777` (deliberately restricted).

### Model access

Only the discovery run needs a model. Set `ANTHROPIC_API_KEY` in `.env`, or run
`ant auth login`. Replay never reads it.

Every command also runs with `--script`, which swaps the model for a recorded
sequence of the same tool calls. Same perception, same policy gate, same
compiler, same artifact — no key, no network, deterministic. That is how the
test suite and `npm run demo` work.

> **The evidence in this repository was produced with `--script`**, because no
> model credential was available where it was built. To produce a genuine
> model-driven discovery run, set a key and drop the flag:
> `npm run discover -- config/goals/member-savings-balance.goal.yaml`.
> It is one run against a local app. See the last section of
> [REPORT.md](REPORT.md).

## Demo path

The whole thread in one command:

```bash
npm run demo
```

Ten steps, about three minutes. It records a capability by driving the app,
replays it against a range of runtime conditions — success, a business outcome,
a rejected input, a session that expires mid-flow, an application abend, and a
second institution's build — then records a second capability whose final step
commits money, shows the approval gate refusing and then allowing it, and prints
the agent-facing catalog. Every run writes evidence to `evidence/runs/`; a
curated copy of the last full run is committed under
[`evidence/`](evidence/INDEX.md).

### Or step by step

**1. Discovery.** With a model:

```bash
npm run discover -- config/goals/member-savings-balance.goal.yaml
```

Without one (same pipeline, scripted decisions):

```bash
npm run discover -- config/goals/member-savings-balance.goal.yaml \
  --script config/scripts/member-savings-balance.script.json
```

Writes `capabilities/meridian.member.savings_balance@1.0.0.capability.yaml` and
a run directory under `evidence/runs/`.

**2. Replay.** No model involved:

```bash
npm run replay -- capabilities/meridian.member.savings_balance@1.0.0.capability.yaml \
  --input memberId=12345
```

Prints the result contract as JSON on stdout. Exit code 0 for success or a
business outcome, 1 for a failure, 3 for an escalation.

**3. Replay into an error.** Ask for a member who does not exist — a business
outcome, not a failure:

```bash
npm run replay -- capabilities/meridian.member.savings_balance@1.0.0.capability.yaml \
  --input memberId=99999
```

Arm a runtime fault in the application and replay again:

```bash
curl -XPOST localhost:8099/_admin/fault -H 'content-type: application/json' \
  -d '{"kind":"session_expire","count":1}'      # recovered: re-auth and rebuild the flow
curl -XPOST localhost:8099/_admin/fault -H 'content-type: application/json' \
  -d '{"kind":"app_error","count":1}'           # escalated: a transaction abend
curl -XPOST localhost:8099/_admin/fault -H 'content-type: application/json' \
  -d '{"kind":"slow","count":1}'                # absorbed: checkpoint polling waits it out
```

**4. Human takeover.** Run anything with `--operator-port`, then open
<http://localhost:8100>. When the run gets stuck or hits a step it is not
permitted to take, the intervention appears there with the screenshot and the
reason. Take control, drive the same live session, hand it back.

```bash
npm run discover -- config/goals/member-open-subaccount.goal.yaml \
  --script config/scripts/member-open-subaccount.script.json \
  --operator-port 8100
```

That flow ends in a posting the agent is not allowed to perform, so it will wait
for you. Add `--auto-operator` instead to have a simulated operator do it (it
goes through the same broker API and the same policy gate, and is labelled as
simulated in the run log).

**5. The agent-facing catalog.**

```bash
npm run catalog -- list                 # what exists, its contract, its approval state
npm run catalog -- tools                # tool definitions, ready for a tool-calling agent
npm run catalog -- lint                 # static review of every artifact
npm run catalog -- invoke meridian.member.savings_balance --input memberId=23456
npm run catalog -- serve --port 8101    # the same thing over HTTP
```

Approving an artifact pins the approval to its content hash, so editing a step
afterwards revokes it:

```bash
npm run catalog -- approve capabilities/meridian.member.subaccount_open@1.0.0.capability.yaml \
  --by "R. Okafor" --note "reviewed against change CR-8841"
```

## Tests

```bash
npm test            # 631 tests
npm run coverage    # the same, with the 100% threshold enforced
npm run typecheck
```

Coverage is 100% of statements, branches, functions and lines across `src/`,
with no exclusions, and `npm run coverage` fails below that. Three things made
that reachable rather than a number to game:

- **The replay engine runs against an in-memory surface** that implements the
  same `SurfaceDriver` interface as the browser adapter
  ([tests/fake-driver.ts](tests/fake-driver.ts)), so each branch of the error
  taxonomy is driven deterministically.
- **The in-page perception pass runs under jsdom** as well as in Chromium
  ([tests/dom-harness.ts](tests/dom-harness.ts)). It normally executes inside
  the browser where Node's instrumentation cannot see it; jsdom gives it a real
  style cascade, so every branch of the name-synthesis cascade is measured. The
  Playwright test remains the check that it still holds in a real browser.
- **Every command is a function of `(argv, io, sessionFactory)`** returning an
  exit code. The only code that reads `process.argv` or calls `process.exit` is
  [bin/handspan.ts](bin/handspan.ts), which contains no logic.

Where a branch turned out to be unreachable defensive code, the defence was
removed rather than hidden behind an exclusion. Several real bugs came out of
the exercise, listed at the end of [REPORT.md](REPORT.md).

## Notes

- Every command is also reachable directly as `npx tsx bin/handspan.ts <command>`;
  the npm scripts are thin aliases. No build step is needed. `npm run build`
  compiles to `dist/` if you want that, and `npm run typecheck` checks
  everything including the tests.
- Nothing here talks to a real financial system, and there is no real PII in the
  repository. The fixture data in `target-app/data.ts` is invented.
- If `npm install` or a test run is inexplicably slow on macOS, check whether
  the checkout is inside an iCloud-synced folder such as `~/Desktop`. With the
  disk near full, iCloud evicts `node_modules` and every first read blocks on a
  re-download; installing outside the synced tree and symlinking `node_modules`
  in makes it a hundred times faster.
