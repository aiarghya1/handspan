# Evidence

Worked runs of the full thread. Each run directory holds:

| File | What it is |
|---|---|
| `run.jsonl` | Ordered structured events: every observation, decision, authorization, action, checkpoint, recovery and escalation |
| `summary.json` | The result contract, exactly as returned to the caller |
| `trace.json` | Discovery runs only: what was done to the application, in the artifact's own vocabulary rather than as a model transcript |
| `screenshots/` | One per action during discovery; always captured on failure and on escalation |
| `snapshots/` | Per-frame HTML, captured on failure and on escalation |

Everything written here passes through the run's redactor, so credentials and
pattern-matched regulated data are scrubbed on the way to disk. Values declared
sensitive in the artifact are logged only as their declared class, never as
values.

## What each run shows

See [INDEX.md](INDEX.md) for the runs captured here and what each one
demonstrates.

[`capability-tools.json`](capability-tools.json) is the same artifacts projected
as tool definitions: what a calling AI agent sees when it discovers the catalog,
including the business outcomes it should branch on rather than treat as errors.
