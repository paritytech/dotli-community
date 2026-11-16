# A rule a lint rule or a test could hold

You are about to write a rule down, or you just turned on a lint rule or added a test that enforces one. The docs agents
read while they work, such as the style guide or a review checklist, seem like they should mention it too.

## How to resolve

1. If a lint rule or a test can express the rule, make it that check instead of a written convention.
2. Put the rule in the check and nowhere else.
3. Leave the context docs without it. If an earlier step already wrote it into one, take it out.
4. Let the check speak. It reports a violation once code is written, with more detail than a line in a doc.

The owner's reason: a check restated in context docs is clutter every reader pays for, and the check reports the
violation anyway.

## Example

The lint config holds the rule:

```js
// eslint.config.js
export default [{ rules: { complexity: ['error', 12] } }];
```

A boundary between folders is a check too, not a sentence in a guide:

```js
// eslint.config.js: other folders import a feature only through its index
'no-restricted-imports': ['error', { patterns: ['**/features/*/!(index).js'] }],
```

The style guide and the review checklist gain no line about either.

## Cases

- Turning on a lint rule had added a style guide paragraph and a checklist row about it. Both were removed. (PR #477)
- The boundary between an app's feature folders became a lint rule rather than a written convention. (PR #479)

Status: active
