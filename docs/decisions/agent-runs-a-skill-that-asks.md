# An agent runs a skill that asks the user

An agent that reaches the owner only through the main session, such as the project agent, runs a skill written for an
interactive session. The skill's steps ask the user, such as for approval before an edit or whether to run another
pass. Running it once in silence looks simpler.

## How to resolve

1. Keep every ask the skill makes.
2. Send each one to the owner as a relayed question, such as a `QUESTION`.
3. Wait for the answer, and let it decide the step.

The owner's reason: the owner wants to be asked wherever the skill asks, and an indirect channel changes nothing about
that.

## Example

The skill says to ask before a substantive edit. The agent relays it:

```text
QUESTION: The review of the design found four vague passages and one unstated assumption. Apply the edits?
  1. Apply all
  2. Apply some (name them)
  3. Skip this pass
```

Not this:

```text
STATUS: Ran the review once and applied every edit.
```

## Cases

- The `architect` agent ran the `document-review` skill once on its own, with no asks. (PR #480)

Status: active
