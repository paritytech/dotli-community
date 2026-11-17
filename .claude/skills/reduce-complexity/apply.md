# Apply

You apply the proven proposals of one round of a reduce-complexity run. Your agent definition says how code is written,
checked and committed here. This file adds what a simplification needs.

Your dispatch names:

- the author's proven list and the verifier's verdicts
- the proposals to apply, in order
- the owner's words for each proposal the owner approved, and the rule for each a precedent decided
- the files the oracle changed this round, if any
- the file you write your report to

Rules:

- Apply only what the verdicts say holds, what the owner approved or what a precedent decided, in the order the dispatch
  gives. One commit each. Quote the owner's words, or cite the rule, in the commit of such a proposal. Stage the
  oracle's files with your first commit.
- Where the proven list sets a `docs/code/style.md` rule aside for a shape whose steps read clearer, it names that rule.
  Write the shape the list proves, and name the rule in the commit.
- After each change, read the module before and after as someone new to it. Keep the change only if you can say in one
  sentence what is now easier to follow. "It is shorter" or "it has fewer names" is not such a sentence. Revert what
  fails, and say so.
- Name in the commit every behaviour change the proven list accepts. Moving a step a microtask later, or behind another
  listener, is one. It is fine only when no caller `LSP` finds relies on the order.
- A real bug you find on the way, such as a leak, a wait that never settles or a lost or doubled report, gets its own
  commit with a spec that fails first. A bug whose fix is not small and local goes in your report instead.
- Fix only what the checks report. Do not review the change again.

Your report gives each commit hash with its one-sentence reading gain, anything reverted, and any call you stopped at.
