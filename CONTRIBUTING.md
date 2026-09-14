# Contributing to dot.li

### How to Test

- **Unit and functional tests** live next to the file they test, named after it (e.g. `permissions.test.ts` alongside `permissions.ts`).
- **Functional tests** live under `apps/host/tests/functional/` (resolution, loading, performance specs driven in-process against the preview server).
- **E2E tests** live under `apps/host/tests/e2e/` (`truapi.spec.ts` exercises the full truapi surface against a real `host-playground.dot` build).
- **Tests are user stories.** Name each test as a user story: `As a <role>, I <action> and <outcome>` for behaviour, or `As a <role>, <observable property>` for invariants.
- **Structure with Given / When / Then.** Every multi-step test body uses `// Given`, `// When`, `// Then` comments to separate setup, action, and assertions.

```ts
test("As a user on a per-tab light client who turns the dotNS cache off, every visit looks the name up again", async ({
  browser,
}) => {
  // Given
  const { context, page } = await setupTest(browser, {
    backend: "smoldot-direct",
    cacheSeed: CACHE_ENABLED,
  });
  await page.goto(BASE_URL, { waitUntil: "commit" });
  await waitForResolutionOutcome(page, TIMEOUT_MS, "smoldot-direct");
  await waitForCachedCid(page, DOMAIN, 5_000);

  // When
  await updateCacheSettings(page, SKIP_CID_ONLY);
  await page.goto(BASE_URL, { waitUntil: "commit" });

  // Then
  await waitForResolutionOutcome(page, TIMEOUT_MS, "smoldot-direct");
  expect(await hostResolveStarted(page)).toBe(true);
  expect(await hasCachedCid(page, DOMAIN)).toBe(true);
});
```

Note what the last line buys. Without it the test passes whether the cache was
skipped or was simply empty, so the assertion above it would mean nothing. A
test that cannot fail for the reason its title gives is worse than no test,
because the suite reports it as coverage.

### How to Document

Good documentation starts with a single, clear sentence. Everything else comes after a newline.

#### Principles

1. **Lead with one sentence.** The first line of any doc comment should explain _what_ the thing does, not _how_. Additional context goes after a blank line.
2. **Don't restate the code.** If the function signature already tells the story, don't repeat it in prose. Document _why_, not _what_.
3. **Use examples.** A short usage example is worth more than a paragraph of explanation.
4. **Link to related items.** Help readers navigate. Reference related functions, types, or modules directly rather than describing them.
5. **Think about context.** If you're explaining too many foreign concepts to document one function, the API design may need work.
6. **No code section separators.** Don't use `// -----------` or similar decorative dividers to split sections within a file. Let the code structure speak for itself.
7. **No em-dashes, semicolons, prose-conjunction `+`, or Unicode arrows (`→`, `←`, `↔`).** Rewrite the sentence. Two short sentences read better than one long one with a dash, and arrows belong in diagrams (where `->` is fine if it's a real arrow, not a stand-in for "becomes" or "then").
8. **No external spec citations in code comments.** Don't write "per RFC 0001" or "see EIP-137" inside a comment. Explain the rule itself. If a reader needs the spec, the commit message and the PR description are the right place. Code comments stand alone.
9. **No "on-chain" in prose.** Say "network" or "remote" instead. The host already knows the data sits on a chain. Calling it "the network value" reads naturally; "the on-chain value" reads as crypto jargon.

#### TypeScript

```ts
/** Resolve a `.dot` label to its IPFS CID via the dotNS contract. */
export async function resolveLabel(label: string): Promise<Cid | null> {
```

- Start with a single-sentence JSDoc comment.
- Add parameter/return descriptions only when the types aren't self-explanatory.
- For modules, put a block comment at the top of the file explaining the purpose and key design decisions.

```ts
/**
 * Two-build, per-product subdomain bridge.
 *
 * The host shell at name.dot.li resolves the label, then iframes
 * name.app.dot.li with the resolved CID threaded through the URL contract. Each product gets a distinct origin so SW, storage, and auth stay isolated across products.
 */
```

### TLDR

1. Start with a single, clear sentence. Follow up after a newline if needed.
2. Don't repeat what the code already says.
3. Use examples and links generously.
4. If documenting something requires explaining too many unrelated concepts, reconsider the API design.
