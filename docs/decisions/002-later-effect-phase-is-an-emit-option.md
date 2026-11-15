# D-002: A second timing phase for a shared primitive's effects is an option on the existing emit, run by the same runner

- Situation: a shared primitive, such as a state machine, emits effects that one runner executes at a fixed point, such
  as right after the step that emitted them. A consumer needs some effects to run at a different point in the same
  call, such as once every queued step has finished but before the outer call returns. The question is what shape that
  second phase takes in the primitive's public API.
- Options:
  - An option on the existing emit, such as `emit(effect, { after: 'drain' })`, run by the same runner. Helpers that
    compose or wrap the primitive pass the option through.
  - A separate emit for the new phase, run by the same runner.
  - A separate runner parameter for the new phase, with its own effect type and its own emit.
- Owner: the option on the existing emit. "1. emit option (Recommended)"
- Why: the owner gave no reason beyond choosing the option offered as recommended. As offered, that option keeps one
  emit and one runner and lets composing helpers pass the phase through unchanged.
- Applies when:
  - the new phase runs the same kind of effect as the existing one, so the same runner can execute it
  - only the timing differs, not what the effect is or who runs it
- Not when: no case yet.
- Source: branch `chore/complexity-cap`, the after-drain effect phase of the shared state machine in the change applying
  the owner's complexity-run follow-up decisions, design `docs/_plans/complexity-followups-design.md`.
- Status: active
