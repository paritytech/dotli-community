# D-003: Structure encoded in a label that is also a saved key moves to its own field, even when old saved keys stop matching once

- Situation: a list of entries carries a structural attribute, such as nesting depth, encoded in each entry's
  human-readable label, such as by leading spaces or a prefix. The same label is also the key under which results are
  saved, and a later run or a comparison script matches against those saved results by key, stripping the encoding to
  print. Moving the attribute to its own field changes the saved keys of the entries that carried it, so one comparison
  against results saved before the change finds no match for them. The question is whether the attribute stays in the
  label or moves to a separate field.
- Options:
  - Each entry gets a plain name and a separate field for the attribute, such as a depth. Renderers derive the display
    from the field, and saved keys become the plain names.
  - Keep the attribute encoded in the label, which stays the saved key.
- Owner: a plain name and a separate field. "1. Plain name + depth (Recommended)"
- Why: the owner gave no reason beyond choosing the option offered as recommended. As offered, that option keeps the
  saved key a plain name and lets each renderer derive the display from the field, at the cost of one comparison against
  results saved before the change finding no match for the entries whose keys changed.
- Applies when:
  - the label is both shown to a reader and used as a key for saved results that a later run compares against
  - the encoded attribute is presentation or structure, not part of the entry's identity
  - the cost of the key change is a one-time mismatch against older saved results, such as a dev-only or CI baseline
- Not when: no case yet.
- Source: branch `chore/complexity-cap`, the phases table of a dev-only performance test whose saved results a script
  compares against a CI baseline, design `docs/_plans/complexity-followups-design.md`.
- Status: active
