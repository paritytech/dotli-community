# A design records what the owner said

A developer writes a design document and records what the owner asked for or decided: the goal of the change, and the
owner's answers to the questions the design raised. Some answers are short picks of an offered option, others are long
informal messages. The question is whether the design quotes the owner's words or restates them.

## How to resolve

1. Work out what the owner meant by each request and each answer, including the points an informal message makes in
   passing.
2. Restate that meaning in the design's own words, as clean sentences beside the goal and each decision.
3. Leave out the owner's words verbatim, the label of a picked option included.

The owner's reason: a restatement shows the owner's words were understood, where a quote only repeats them.

## Example

```markdown
## Goal

Every shared widget has a story, and a story file older than the new contract fails the check until it is migrated.

## Decisions

- Old story files are marked for migration rather than skipped, and the check reports them as errors.
```

Not this:

```markdown
## Goal

Stories for widgets. Owner: "yeah all the shared ones need stories, the old files too i guess"

## Decisions

- Old files: "Error, mark old files (Recommended)"
```

## Cases

- A design quoted the owner's short option picks and a long informal message about which components deserve stories,
  and the owner asked to be paraphrased and understood instead of quoted. (design `docs/_plans/story-contract-design.md`,
  branch chore/story-contract)

Status: active
