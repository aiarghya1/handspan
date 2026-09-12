# Evidence index

Produced by `npm run demo`. Each directory is one run; see
[README.md](README.md) for what the files inside are.

| Run | Result | What it demonstrates |
|---|---|---|
| [`01-discovery-savings-balance`](01-discovery-savings-balance/) | recorded meridian.member.savings_balance@1.0.0, 9 actions | Discovery. The agent signs on with a vault reference it never sees, meets the maintenance interstitial, navigates to member inquiry, looks up a member and reads two declared return values. Compiles to the artifact below. |
| [`02-replay-success`](02-replay-success/) | success, outputs {"memberName":"DELACROIX, R M","savingsBalance":4182.55} | Deterministic replay, no model. Typed outputs returned; the interstitial handled by a declared recovery rather than by a recorded step. |
| [`03-replay-business-outcome`](03-replay-business-outcome/) | business outcome MEMBER_NOT_FOUND, data {"searchedFor":"99999"} | A member that does not exist. Reported as the named outcome MEMBER_NOT_FOUND with the id it searched for, not as a failure. |
| [`04-replay-session-expired`](04-replay-session-expired/) | success, outputs {"memberName":"DELACROIX, R M","savingsBalance":4182.55} | The session expires part-way through the flow. The recovery re-authenticates and rebuilds the prefix with replayFrom: signon, and the run still succeeds. |
| [`05-replay-app-error-escalated`](05-replay-app-error-escalated/) | escalated (app-error) -> abort | The application aborts a transaction. Escalated to a human rather than retried, because nothing the caller can do with an abend reference. |
| [`06-replay-cross-tenant`](06-replay-cross-tenant/) | success, outputs {"memberName":"DELACROIX, R M","savingsBalance":4182.55} | The same artifact, unchanged, against a second institution on a later and differently branded build of the same vendor product. Two label aliases carry it. |
| [`07-discovery-subaccount-escalation`](07-discovery-subaccount-escalation/) | recorded meridian.member.subaccount_open@1.0.0, 13 actions, 1 step performed by an operator | Discovery of a flow that commits. Policy refuses the posting, the intervention is routed with the exact action it wanted, an operator performs it in the same live session and hands control back, and the run continues. The artifact comes out irreversible and requiring approval. |
| [`08-replay-subaccount-posted`](08-replay-subaccount-posted/) | success, outputs {"confirmationNumber":"8831-2002"} | The approved capability replays unattended, posts the sub-account, and returns the confirmation reference. Before approval the same call is refused with not_approved. |
| [`09-operator-takeover-and-resume`](09-operator-takeover-and-resume/) | success, outputs {"memberName":"DELACROIX, R M","savingsBalance":4182.55} | A human takes control of the live session through the operator console, clears the screen by hand, is refused when they try to navigate outside the allowlist, hands control back, and the run resumes and completes. Every manual action is in `run.jsonl` as an `operator.action` event, including the refused one. |

## The artifact

[`capability/`](capability/) holds the capability artifacts the discovery
runs compiled. They are the review unit: the whole public contract is the
`params`, `returns` and `outcomes` at the top, and every step carries the
condition that proves it worked.

## A note on how these were produced

The runs here used the scripted planner rather than a live model, because no
model credential was available in the environment this was built in. The
pipeline is identical either way. See the last section of
[../REPORT.md](../REPORT.md).
