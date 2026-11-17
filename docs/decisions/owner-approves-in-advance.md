# The owner approves in advance

The owner starts a change with an approval given up front, such as "I approve in advance, just do it". The change runs
in a project agent whose design and slice gates would each stop for the owner. Later in the same session the owner asks
for follow-up changes on the same branch, each dispatched to a new project agent. The question is whether the advance
approval passes those gates too, or whether each gate still waits for the owner.

## How to resolve

1. Treat the advance approval as passing every `APPROVAL` gate of the change it came with: the design, each slice and
   the start of the review. The agent reports what it passed and keeps going, without stopping for an answer.
2. Keep the advance approval standing for each follow-up change the owner asks for on the same branch in the same
   session.
3. When the main session dispatches a follow-up change's agent, pass the advance approval with the request, so that
   agent's gates run without stopping too.
4. Still bring every `QUESTION` and `BLOCKED` to the owner. An advance approval passes gates, not open questions.

The owner's reason: once the owner has said to just do it, a gate that stops anyway, or a later change on the same
branch that forgets the approval, makes the owner repeat it for nothing.

## Example

The owner approved in advance at the first change, then asks for a follow-up on the same branch. The dispatch carries
the approval:

```text
OWNER: drop the legacy export format from the settings screen
OWNER (advance approval, given earlier on this branch): I approve in advance, just do it
```

Not a dispatch with the request alone, whose agent then stops at its design gate and again at each slice.

## Cases

- On one branch, the first change came with an advance approval, yet its agent stopped at a slice gate and the owner had
  to approve again. The second change came with its own advance approval. The third was dispatched without it, and its
  agent stopped at the design and slice gates until the owner pointed out the approval given in advance.
  (feat/browser-device-permissions)

Status: active
