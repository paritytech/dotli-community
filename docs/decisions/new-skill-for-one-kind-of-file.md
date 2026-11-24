# A new skill for one kind of file

You are adding a skill that tells an agent how to plan and write one kind of file, and it comes with a contract doc
under `docs/code/` for that kind. Now the workflow has to pick it up. Several agents may write such a file, such as the
implementer or a main session, and the `reviewer` skill should cite review rows for it. Two questions follow:

- How do the agents that write the file come to run the skill? Through its description alone, a line in each agent's
  definition that writes that kind of file, a line in `AGENTS.md`, or several of these?
- Where do the review rows for that kind of file live? In a section of a checklist the reviewer already loads, or in a
  new checklist file with its own loading step?

## How to resolve

1. Write the skill's description so it names the kind of file it covers, which lets it trigger on its own.
2. Add one line to `AGENTS.md` that names the contract doc and the skill for that kind of file, so every session and
   agent sees it.
3. Add no line about it to an agent's definition, such as the implementer's.
4. Put the review rows in a new section of the `docs/claude/` checklist the reviewer already loads when a diff touches
   that kind of file, beside the section closest to it. Add no checklist file and no loading step to the reviewer skill.

The owner judged the `AGENTS.md` line and the skill's description enough, with no further wiring. For the review rows
the owner chose the section in the existing checklist without stating a reason.

## Example

```markdown
<!-- .claude/skills/write-migration/SKILL.md -->
---
name: write-migration
description: Plan and write a database migration file. Use when a change adds or edits a migration.
---
```

```markdown
<!-- AGENTS.md -->
- A migration file follows `docs/code/migrations.md`. Write one with the `write-migration` skill.
```

```markdown
<!-- docs/claude/code-checklist.md, already loaded when a diff touches a migration -->
## Tests
...
## Migrations
- **major** a migration that cannot run twice ...
```

Not this: the same line also added to `.claude/agents/code-writer.md`, saying a slice that writes a migration runs the
skill. Nor a new `docs/claude/migration-checklist.md` with a step in the reviewer skill that loads it when the diff
touches a migration.

## Cases

- A new skill for planning and writing Storybook story files came with a contract doc for story files. The owner chose
  a line in `AGENTS.md` naming both, plus the skill's description, over a line in the implementer's definition.
  (chore/story-contract branch, design `docs/_plans/story-contract-design.md`)
- The same change needed reviewer rows for story files. The code checklist already loads when a diff touches a
  component, its CSS module or its story. The owner chose a new section in it beside its Tests section over a new
  checklist file for story files that the reviewer skill loads on its own. (chore/story-contract branch, design
  `docs/_plans/story-contract-design.md`)

Status: active
