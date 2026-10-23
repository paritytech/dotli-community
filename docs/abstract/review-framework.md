# Architecture Review Framework for dotli

A repeatable way to review a client-side codebase that has grown tangled: high coupling, rules scattered across
components, a boundary that is hard to point at. It is written for an engineer running the review (alone or with the
team) and produces a short list of prioritized findings, each tied to a concrete next step and a check that stops it
from regressing.

You do not read this top to bottom every time. Read sections 1 to 4 (the model, the concepts, the inputs, the procedure)
once to understand it. Then use sections 5 and later as the working checklist.

## 1. The idea in one paragraph

A complex client fails for two related reasons: **coupling that nobody decided on** (changing one thing breaks five) and
**a model that was never made explicit** (rules dissolve into the view). This review does three things about that. It
locates where boundaries are missing, makes the trade-offs behind the current design explicit instead of accidental, and
converts each problem into an automated check so the conclusion stays true after you have moved on. Everything below is
an instance of that loop: _find a boundary that should exist, decide the least-worst way to introduce it, lock it in
with a check._

## 2. Three concepts this document keeps using

Define these once. The rest of the document assumes them.

**Coupling** is how much one part of the system must know about another in order to work. Some coupling is unavoidable.
The problem is coupling that forms without anyone choosing it. Two kinds matter:

- _Static coupling_: what imports what. Visible in the dependency graph. Too much makes the code rigid.
- _Dynamic coupling_: what talks to what at runtime, such as shared stores, global events, postMessage traffic and
  parameter chains. Too much makes behavior unpredictable.

**Boundary** is an explicit seam across which two parts agree on a contract and otherwise stay ignorant of each other. A
_bounded context_ is a boundary in the domain (resolving a name and proving content each have their own model). An
_anti-corruption layer (ACL)_ is a boundary against an external system: a translation layer so an outside API's shapes
do not leak inward. In dotli the host and sandbox boundary, the protocol frame and the package public surfaces are
boundaries. Boundaries are the main tool for controlling coupling.

**Trade-off and fitness function.** A _trade-off_ is the quality you gave up to get the one you wanted (speed now versus
evolvability later). A _fitness function_ is an automated check that fails when an architectural property you care about
is violated. It is the mechanism that keeps a boundary or rule enforced over time instead of relying on memory and
discipline.

## 3. Before you start: inputs to gather

The review is only applicable if you have the project in front of you in these forms:

- **The dependency and import graph.** Some way to see what imports what across packages and apps, including cycles.
  This is your static-coupling map. `docs/code/placement.md § Layer map` summarises the intended one.
- **A change-frequency heatmap.** Which files and packages churn most (commits touching each path over the last several
  months). This tells you where coupling actually hurts.
- **The glossary.** The words the product uses (`## Glossary` in `AGENTS.md`), and whether the code uses the same ones.
- **The external integration points.** Every API, SDK, chain connection, gateway, the host to sandbox wire and the
  protocol frame the client touches.
- **The current structure and ownership.** Apps, packages, `config/*` packages, and who (if anyone) owns each area.

If you cannot produce the first two maps, build them first. The rest of the review leans on them.

## 4. How to run the review

1. **Set priorities first (about 30 minutes, with the team).** Before judging anything, name the project's top
   architectural qualities and rank them (section 8). dotli's ranked qualities come from `AGENTS.md § Project`:
   trustless (no server in the trust path), small on boot, fast on repeat visits. You cannot call something a problem
   until you know what the system is optimizing for.
2. **Overlay the two maps.** Put the dependency graph next to the churn heatmap. The packages that are both heavily
   coupled and frequently changed are where you start, because that is where coupling taxes you daily.
3. **Walk dimensions 5 to 7 against the hot packages first.** Use the probes and red flags. Do not try to cover the
   whole codebase. Cover the part that is costing you.
4. **Record each finding** with the template (section 11). For every finding, decide the least-worst _incremental_ step
   and the fitness function that would lock it in (dimension 9 and section 11).
5. **Check boundaries and ownership (dimension 10).** This is a whole-project pass, not per package.
6. **Prioritize and write up** (section 12). The output is a short document of findings, not an annotated tour of the
   codebase.

## 5. Dimension: model and the UI to logic boundary

**What this is.** In a client, rules tend to dissolve into components: a validation here, a derived value there, a
branch in a render path. The model stops being a thing you can point at and becomes an emergent property of the whole
app. This dimension checks whether the logic is a distinct, nameable layer with explicit boundaries. The harder the
model, the more this matters. Scattered rules are the single biggest driver of "change one thing, break five."

**Vocabulary in play:** ubiquitous language (one concept, one name everywhere), bounded context, invariants enforced in
one place, anti-corruption layer.

**Probes:**

- Can you point to a package where the logic lives without depending on the UI framework or the DOM? If not, the logic
  is nailed to the UI. The content proof in `@dotli/content` is the intended shape: it checks a block against its CID
  with no view code.
- Is the same concept named consistently everywhere? (Classic offenders: `product` and `app`, `host` and `shell`,
  `sandbox` and `app context`.)
- Can you enumerate the bounded contexts (resolving, fetching, chain connections, the protocol frame, storage), or is
  there one shared module that knows about everything?
- Where are invariants enforced, in one place or re-checked ad hoc inside handlers? "A block is trusted only after its
  CID check" needs one verifier per block source, not a re-check inside each handler.
- At the boundary with external systems (gateways, peers, the light client, product code in the sandbox), is there an
  ACL, or do raw external shapes crawl all the way into components?

**Red flags:**

- Logic packages import the UI framework or the DOM.
- "Smart" components mixing rendering, rules and network calls.
- Raw external structures (RPC responses, unverified blocks, product messages) appearing in props and UI state.
- One glossary in design and with product, a different one in code.

**Fitness functions:**

- A package may not import the UI package or the host. This is an import-boundary rule in its `eslint.config.js`.
- External data may be trusted only after the verifier for its source, for example the CID check in `@dotli/content` for
  gateway blocks and the host's block relay for Bitswap blocks.
- A living glossary plus a check on banned synonyms.

## 6. Dimension: coupling and modularity

**What this is.** This is usually the loudest symptom in a "high coupling" project, so it is where measurement pays off
most. You are looking at both the static graph (imports) and the dynamic graph (runtime communication), and asking which
dependencies exist by decision versus by accident.

**Probes (static):**

- Are there cycles in the package graph?
- Is there a "god package", a `shared` or `utils` that almost everything depends on? That is the worst kind of incoming
  (afferent) coupling.
- Standard metrics compute directly on the TS graph: afferent (Ca) and efferent (Ce) coupling, instability
  `I = Ce / (Ca + Ce)`, distance from the main sequence. Packages with high Ca and high instability are the priority to
  stabilize.

**Probes (dynamic):**

- Global stores everyone reads and writes, global events outside a real system boundary, postMessage channels with no
  typed contract, parameter chains through many levels.
- When you change one piece, how many others must know immediately (synchronous coupling) versus can find out later
  (asynchronous)?
- The smallest replaceable slice: what can you delete or swap without touching the rest? For dotli the natural candidate
  is one package behind its public surface, or one app.

**A sharper code-level vocabulary** than static and dynamic is connascence: of name, type, meaning, position, execution
order. It is useful for naming _why_ two places are coupled and how painful the change would be.

**Red flags:**

- A change in one package reliably breaks 5 or more places unrelated in meaning.
- State written from many places with no single owner.
- "Magic" strings, indices or call ordering acting as an implicit contract.
- A host to sandbox message with no shape in the wire package.

**Fitness functions:**

- CI fails on import cycles.
- Layers encoded as import rules in each `eslint.config.js`: who may depend on whom.
- A coupling budget: alert when a package's efferent coupling crosses a threshold.
- Dead-export detection, to shrink the coupling surface.

## 7. Dimension: state and data

**What this is.** A client is a small distributed data system: remote data, local data, and views derived from both, all
trying to stay consistent. Most bugs in such apps are not logic errors. They are _consistency_ errors, where two copies
of the same fact drift apart. This dimension finds, for each fact, where the single source of truth is and whether
everything else is computed from it or hand-synchronized. The shared store in the protocol frame, the saved light client
database and the content cache make this especially live.

**Probes:**

- For each piece of state: source of truth or derived? Is derived data computed, or is a cache kept in sync by hand (the
  prime desync source)?
- Is state that flows up to a layer owned by the layer below it? "State flows up, intent flows down" is the dotli rule.
  Does a layer write another layer's state, or use state as a command?
- Is a repeated or overlapping call safe? Calls across layers are meant to be idempotent.
- Retries, and recovery after a lost frame, a dropped connection or a stale cache: does the owning layer heal itself and
  report status upward?
- Change propagation: how does an update reach the views, and does one change trigger a cascade of redraws?

**Red flags:**

- The same fact living in three places (store, cache, component-local) and "synchronized" manually.
- Derived data stored rather than computed.
- State collapsed into a single boolean `isLoading`, with no "stale", "error" or "empty".
- A duplicate resource (two connections, two listeners) fixed by a flag instead of one refcounted owner.

**Fitness functions:**

- A test asserting one source of truth per fact.
- Contract tests on the mapping from external data to the internal shape.
- Startup size budgets on the first page load, which CI already guards.

## 8. Dimension: architectural characteristics and trade-offs

**What this is.** Every architecture optimizes for some qualities at the expense of others. The failure mode is not
choosing wrong. It is never choosing, so the optimization happens by accident. This dimension checks whether the
priority qualities are named, and whether shaping decisions were recorded with the trade-off they made. (Run this
_first_ in practice, step 1 of the procedure, because the priorities decide what counts as a problem elsewhere.)

dotli's ranked qualities are set in `AGENTS.md § Project`: **trustless** first, then **small on boot**, then **fast on
repeat visits**. A server in the trust path breaks the first quality and so outranks a slow first paint.

**Probes:**

- Are the driving qualities named and ranked, and is that written down or living in heads?
- Are non-obvious decisions recorded with the alternatives and what was sacrificed?
- At key forks, can you state "if we swap A for B, which quality improves and which degrades"?

**Red flags:**

- "We did it this way because we are used to it," with no recorded reason.
- Optimizing for a quality that is not a priority (shaving a cache lookup at the expense of the content proof, or adding
  a convenience backend that sits in the trust path).

**Fitness functions:**

- A decision record in the repo for changes that cross a boundary.
- A qualities checklist in the PR description for architecturally significant changes.

## 9. Dimension: evolvability and fitness functions

**What this is.** A review is a snapshot, and architecture decays continuously. This dimension is less "what is wrong
now" and more "which of our rules are enforced by a machine versus held together by discipline." Everything you flag in
dimensions 5 to 8 should ideally graduate into a check here. An evolutionary architecture rests on three things:
incremental change, fitness functions and appropriate coupling.

**A catalog of fitness functions to assemble (TS and frontend):**

- Layer purity (a logic package must not import the UI or the host), as an import rule.
- Package boundaries as import rules in `eslint.config.js`.
- Zero import cycles.
- Complexity budgets: function complexity, file and module size.
- Startup size budgets, as a "complexity is not growing unnoticed" signal.
- Type-level invariants as compile-time checks: branded types for ids (you cannot pass a CID where a block hash is
  expected), exhaustive `switch` over unions, a minimum typed-code coverage threshold.
- Contract tests on the ACL.

**Probes:**

- Can a typical change be made in small steps, or does it fan out across the whole tree?
- How many architectural rules currently rest on code review (discipline) instead of CI?

**Red flags:**

- Architectural agreements that are entirely verbal.
- Complexity and coupling growing with nothing measuring it.

## 10. Dimension: cognitive load and boundaries

**What this is.** Code structure and team structure shape each other (Conway's Law). The practical metric is cognitive
load: how much someone must hold in their head to safely change an area. When boundaries do not match how people
actually work, every change spills across them. This is a whole-project pass.

**Probes:**

- Do package boundaries match how people reason and work? Does the code structure mirror the team structure deliberately
  or by accident?
- Is there an area too large to hold in one head?
- Is `@dotli/ui` the thinnest viable platform offered to the apps, or a dumping ground everything flows into? Is
  `@dotli/shared` the same?

**Red flags:**

- Any change requires an expert in "everything at once."
- The shared layer keeps growing because "there is nowhere else to put it."

**Fitness functions:**

- Explicit ownership by package. A package with no clear owner signals a blurred boundary.
- A "how many layers does the average PR touch" metric. Rising means worsening boundaries.

## 11. Recording a finding

Capture each finding in this shape:

```
Dimension:        [5 to 10]
Principle:        [which idea, e.g. anti-corruption layer]
Observation:      [what you actually saw in the code or architecture]
Trade-off:        [what we gain or lose now, and by changing it]
Severity:         [blocking / major / minor]
Recommendation:   [a least-worst, incremental step]
Fitness function: [the check that locks it in]
```

**Worked example.** This scenario is illustrative.

```
Dimension:        5 (logic and UI boundary)
Principle:        Anti-corruption layer
Observation:      Raw gateway responses are read directly inside three sandbox
                  components. Nothing sits between the unverified bytes and the
                  view, so the CID check can be skipped by any new component.
Trade-off:        Now: less code, quick to wire up. Later: a second block source,
                  or a change in the gateway response shape, ripples into every
                  component that touched it, and any miss puts an untrusted
                  gateway in the trust path. We are trading the first quality
                  (trustless) for present speed.
Severity:         Blocking. The trust path is the top-ranked quality.
Recommendation:   Route every gateway block through the one place that checks it
                  against its CID. Migrate one component first to validate the
                  shape.
Fitness function: Import rule: components may import only the verified-file
                  type, never the raw block type.
```

The example shows the point of the template. The _trade-off_ line is what turns a complaint into a decision, and the
_fitness function_ line is what keeps the decision from quietly reverting.

## 12. Prioritization

Do not fix everything. Aim at the intersection of two axes:

- **Coupling** (dimension 6: high Ca, instability, cycles).
- **Change frequency** (the churn heatmap from section 3).

Packages that are both heavily coupled and frequently changed carry the most leverage, because that is where coupling
taxes velocity every day. Stable, rarely touched areas with poor coupling can be deliberately left alone, recorded as an
accepted trade-off rather than silently ignored.

## Appendix. Sources: what each book contributes

- **Domain-Driven Design** (Evans, Khononov): separating logic from UI, ubiquitous language, bounded contexts, the ACL
  at external boundaries. Dimension 5.
- **Software Architecture: The Hard Parts** (Ford, Richards, Sadalage, Dehghani): static and dynamic coupling
  vocabulary, qualitative trade-off analysis, "least-worst trade-off." Dimensions 6 and 8.
- **Building Evolutionary Architectures** (Ford, Parsons, Kua): fitness functions, incremental change. Dimension 9.
- **Designing Data-Intensive Applications** (Kleppmann): source of truth versus derived data, consistency across remote,
  local and offline state, conflicts and optimistic updates. Dimension 7.
- **Fundamentals of Software Architecture** (Richards, Ford): explicit architectural characteristics and decision
  records. Dimension 8.
- **Team Topologies** (Skelton, Pais): cognitive load and boundaries via Conway's Law, the "thinnest platform" idea for
  the UI kit and shared package. Dimension 10.
