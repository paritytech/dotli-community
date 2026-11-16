# D-008: When an app's source is grouped by flow, each flow's functional and end-to-end tests live in its flow folder, under `__tests__/functional/` and `__tests__/e2e/`, while the suite machinery stays in the app's `tests/`

- Situation: an app's source is regrouped into one folder per flow, and its functional and end-to-end tests sit in a
  separate top-level test folder filed by kind of test. The question is whether those tests follow the source into the
  same grouping, and if so where they sit relative to the flow folder.
- Options:
  - A: the top-level test folder keeps its current folders. Only import paths change.
  - B: the functional tests run on a mocked DOM move into a per-flow tree under the top-level test folder, mirroring
    the flow folders. Browser suites keep their folders.
  - C: every functional test moves beside its flow in the flow's source folder, and the rule for the top-level test
    folder changes.
- Owner: every test of a flow lives inside the flow folder. First answer: "use tests/feature/<name>/__tests__/functional
  path. same for e2e, __tests__/e2e . it will be much simpler". Asked whether that meant inside the flow folder or a
  literal `tests/features/<name>/__tests__/` tree, the owner chose: "Inside src/features (Recommended)".
- Why: "it will be much simpler"
- Applies when:
  - an app's source is grouped into one folder per flow, and the question is where that flow's functional or end-to-end
    tests sit
  - the flow's functional tests go in `<flow folder>/__tests__/functional/`, both those run on a mocked DOM by the unit
    runner and the browser functional specs
  - the flow's end-to-end browser specs go in `<flow folder>/__tests__/e2e/`
  - a spec that spans several flows goes in the `__tests__/` of the folder that composes the app, such as its shell
  - the suite machinery stays in the app's top-level test folder. That covers the browser test configs and their global
    setup, the fixtures and helpers specs share, and a suite that measures the whole app, such as a performance suite.
  - unit specs stay beside their module
  - the folder is an app's flow folder. A package keeps its own top-level `tests/` rule.
- Not when: no case yet.
- Source: the change that regroups the host, sandbox and protocol apps by flow, design
  `docs/_plans/app-flow-folders-design.md`.
- Status: active
