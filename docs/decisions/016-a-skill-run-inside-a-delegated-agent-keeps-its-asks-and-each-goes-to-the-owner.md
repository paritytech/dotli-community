# D-016: When an agent that cannot reach the owner directly runs a skill whose steps ask the user, each ask goes to the owner through the main session, and the agent never drops the asks to run a silent pass

- Situation: an agent that talks to the owner only through the main session, such as a project agent running a change,
  runs a workflow skill written for an interactive session. The skill's steps ask the user, such as approval before a
  substantive edit or a choice whether to run another pass. The question is whether the agent keeps those asks or runs
  the skill once on its own and asks nothing.
- Options:
  - The agent runs one pass by itself and asks nothing.
  - Each ask of the skill goes to the owner as a `QUESTION` relayed through the main session, and the owner's answer
    decides.
- Owner: each ask of the skill goes to the owner through the main session. The owner expected this to be the default
  from the start.
- Why: the owner wants to be asked wherever the skill asks, and saw no reason the agent's lack of a direct channel should
  drop those asks.
- Applies when:
  - the agent running the skill reaches the owner only by a relayed message, such as a `QUESTION`
  - the skill's own steps ask the user for an approval or a choice
- Not when: no case yet.
- Source: branch `docs/prompt-audit-fixes` (PR #480), a prompt audit of the `document-review` skill run by the
  `architect` agent from the `architecture` skill's design step.
- Status: active
