# Docs Guide

This directory owns architecture and developer-reference docs for dotli.

## Docs Content Rules

- Order services, providers, and chains alphabetically unless the section is explicitly describing runtime order or
  auto-detection order.
- Use the same names the code uses (`smoldot-shared-worker`, `BULLETIN_PASEO_GENESIS`).

## Docs Map

- `docs/abstract/`: general design thinking (event storming, review framework, simple versus easy).
- `docs/assets/`: images the docs embed, such as the smoldot diagrams in `docs/resolution-design.md`.
- `docs/claude/`: the architecture and code checklists the reviewer skill cites.
- `docs/code/`: the glossary, the placement rules, the code style and the rule extraction procedure.
- `docs/RFC/`: the RFC 2119 requirement keywords.

`docs/_plans/` and `docs/_reviews/` are local working folders and are not committed.
