# Glossary of workflow thresholds

These terms recur as thresholds in the skills and checklists. Use these definitions and do not reinterpret them. They
are workflow thresholds only. The product terms (Host, Sandbox, dotNS and so on) live in the `## Glossary` of
`AGENTS.md`.

## Change size

**Non-trivial change**: any change to `apps/`, `packages/` or `config/` that is not a trivial edit. There is no other
trigger list. If unsure, it is non-trivial.

**Trivial edit**: a change confined to one existing file plus its peer files, with no new file, no new public surface,
no crossing between layers and no new flag or branch on a path other callers share. It applies to `apps/`, `packages/`
and `config/`. CI workflows, nginx, deploy, dependency bumps and releases never trigger the `architecture` skill.

Worked examples:

- Changing a padding in one component's CSS module, together with its story, is trivial. The CSS module is the one
  existing file and the story is a peer file.
- Adding an export to a package's `src/index.ts` is non-trivial. It is new public surface.

**Blast radius**: the set of files and layers that must change for a change to be complete, measured with references and
call sites of every symbol and public surface touched, never estimated from the description. Reported as
`N files, M layers`, with files and layers as defined here. A large radius measures existing complecting, not a property
of the change itself.

**Complecting**: braiding two concerns together so neither can change without touching the other. A change adds braid
when it puts a second concern in one place (a flag on a shared path, a field on a shared type, a branch others must now
know about) or spreads one concern across more places (a parameter threaded through callers that have no use for it). It
is orthogonal to size: a three-line diff can add braid and a large rename can add none. The cost is paid by every later
change, not seen in the current diff. See `docs/abstract/simple-vs-easy.md`.

**Frame**: the change stated in one sentence in one layer's vocabulary. A frame states the concern, not the cost. When
the measured blast radius contradicts the frame (one layer's vocabulary, three layers of artifact), that gap is a
finding that stops for the owner.

## Scope

**Layer**: one package (`packages/*`), one app (`apps/*`) or one `config/*` package. A module's responsibility layer
inside a package is what the `## Architecture` gate in `AGENTS.md` checks, not this term.

**Public surface**: a package's `src/index.ts` exports and its `package.json` `exports` entries. Everything else is
internal.

**Peer file**: a file that mirrors or directly supports a touched file and shares its scope. Editing a peer does not
need re-approval. The peer files are:

- the spec beside a touched module
- its `*.fake.ts`
- its story
- its CSS module
- an edit to an existing `src/index.ts` re-export line
- the package `README.md`

Adding a re-export is new public surface, not a peer edit. Anything else touched outside the stated files that is not a
peer is scope creep. Stop and confirm with the owner.
