# Handspan

Record-once / replay-many computer-use capabilities for legacy back-office
banking applications.

Banks and credit unions run a long tail of back-office applications with no
API. The only way in is to drive the UI the way an operator would. Handspan
uses a model **once**, to discover how a task is done, compiles that run into a
typed, versioned, reviewable **capability artifact**, and thereafter replays the
artifact deterministically with no model in the decision loop.

> The model discovers. The artifact is the capability. Deterministic replay is
> how an agent invokes it.

## Status

The system is being built up one feature per pull request. `main` carries the
tooling and the target application; each merged pull request adds one capability
area with its tests.

## The target application

`target-app/` is a deliberately dated credit-union servicing application —
framesets, layout tables, inputs with no accessible names, a nightly-batch
interstitial, session expiry, and validation and abend screens. It is the live
surface everything else is developed against. Two variants run side by side so
the multi-tenant path has something real to specialise for.

```bash
npm install
npm run target-app          # http://localhost:8099
npm run target-app:v9       # http://localhost:8199, one vendor release ahead
```

## Layout

| Path | What it holds |
| --- | --- |
| `target-app/` | The legacy application under automation |
| `config/` | App profiles, goals and policy |
| `src/` | The system itself |
| `tests/` | Unit, integration and in-page tests |
| `evidence/` | Saved runs: discovery, replay, and replay hitting an error |

## Requirements

Node 20 or newer. Replay needs no model access; only a discovery run does.
Copy `.env.example` to `.env` and fill in what you need.
