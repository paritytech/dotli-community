# D-001: A lint rule stays in the lint config and is never restated in the context documents agents read

- Situation: a change adds or turns on a lint rule. The question is whether the rule is also written into the context
  documents that agents read while they design, write or review code, such as the code style guide or a review
  checklist's list of what the linter catches.
- Options:
  - Restate the lint rule in the context docs, such as a paragraph in the style guide and a row in the review
    checklist's list of what the linter catches.
  - Leave the rule in the lint config alone. The lint run reports it once code is written, and context docs carry no
    lint rule info.
- Owner: leave the rule in the lint config alone. "DO NOT trash context documents with eslint rules info - it will be
  notified anyway after code got written. it's bad behavior, automatic check will tell you more then some rule from
  context"
- Why: "it will be notified anyway after code got written" and "automatic check will tell you more then some rule from
  context"
- Applies when:
  - the rule lives in a lint config and the lint run reports a violation once code is written
  - the text in question would only restate or announce that rule in a style guide, checklist or other context document
- Not when: no case yet.
- Source: branch `chore/complexity-cap` (turning on ESLint `complexity`), design
  `docs/_plans/complexity-cap-design.md`. The change had added a paragraph to the style guide and a row to the code
  review checklist, both removed after the owner's words.
- Status: active
