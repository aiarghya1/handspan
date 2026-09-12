# Desktop surface — not built

This directory is a placeholder for the adapter that would implement
`SurfaceDriver` over UI Automation (Windows) or the macOS accessibility API.
It is empty on purpose, and the seam it would plug into is the point.

Everything above `src/surface/types.ts` — the discovery agent, the locator
ladder in `match.ts`, the condition evaluator, the whole replay engine — is a
pure function over a list of named controls. A desktop adapter owes it three
things and nothing else:

| Contract | Web implementation | Desktop implementation |
|---|---|---|
| `observe()` | DOM walk with synthesized accessible names | UIA `FindAll` / AX `AXUIElementCopyAttributeValues` over the window tree |
| `Control.role` | ARIA role, or inferred from the tag | UIA `ControlType` / AX `AXRole` — the vocabulary in `CONTROL_ROLES` is already the intersection |
| `Control.name` | `aria-label`, `<label>`, adjacent cell, column header | UIA `Name` / AX `AXTitle`, which these toolkits populate far more reliably than legacy HTML does |
| `Control.framePath` | frame name chain | window / pane / tab-item path |
| `Control.hints.selector` | best-effort CSS | `AutomationId` |
| `resolve()` | `resolveFromControls` over the perceived list | the same function, unchanged |
| act | Playwright `click` / `fill` / `selectOption` | UIA `Invoke` / `SetValue` patterns |

What would *not* carry over unchanged, and is adapter-local in each case:

- `structureSnapshot()` becomes a control-tree dump rather than frame HTML.
- Screenshot masking becomes region-based rather than locator-based, since there
  is no equivalent of Playwright's `mask`.
- The operator-attach path becomes a screen share or RDP session rather than a
  CDP URL.
- `waitForQuiescence` has no `networkidle` equivalent; it would watch for the
  window to stop reporting `AXBusy` / for a UIA structure-changed event to settle.

The reason the model was never given coordinates is here: a coordinate is not
expressible in this table. Constraining the action space to named controls is
what makes the recorded artifact portable across the column boundary.
