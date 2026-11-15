# Decisions

The owner's decisions, kept as precedent. Each one records the situation and the owner's choice, with the owner's reason
and when it applies. A later question of the same kind is answered from here instead of asking the
owner again.

The `decision-keeper` agent owns this folder. It answers questions from it, files new decisions and keeps this README
current. No session reads the folder at start. A session reaches it only through the keeper, when a question comes up.

The owner may change or revert any decision. A change here lands in the same commit as the work that caused it.

## Layout

One file per decision, `<NNN>-<slug>.md`, with `NNN` zero-padded and increasing. The ID is `D-<NNN>`. Each file holds:

- the decision as its title
- the situation, in general terms
- the options
- the owner's choice, verbatim
- the reason
- when it applies, and when it does not
- the source of each case
- its status: active, superseded by another decision, or enforced by a lint rule or test
