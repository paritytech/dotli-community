# D-007: When a regrouping mixes unit specs that the test config set up by folder, all unit specs run in one test project with every setup applied, once a run shows they all pass that way

- Situation: a test runner config splits an app's unit specs into projects by folder glob, and each project gives its
  specs an environment and a setup, such as a setup file or browser resolve conditions. The source is regrouped, such
  as by flow, so one folder now holds specs that used to get different setups. The question is how the config picks
  each spec's setup after the regrouping.
- Options:
  - A: pick by file name. A suffix or infix on the spec name, such as `*.ui.spec.ts`, selects the project.
  - B: one project for all unit specs, with the setup file and the browser conditions applied to every spec, if they
    pass that way.
  - C: keep folder globs, listing the subfolders or files of each flow that need each setup.
  - D: each spec that needs a setup installs it itself, through an import or a per-file environment comment, and the
    config has one project.
- Owner: option B. "One project for all (Recommended)"
- Why: the owner gave no reason beyond choosing the option offered as recommended. As offered, that option drops the
  per-folder split, so a regrouping never has to keep globs or file names in step with which spec needs which setup. A
  probe had shown every spec of the app passing under one project with both setups applied.
- Applies when:
  - a test config assigns unit specs their environment or setup by where they sit, and a regrouping breaks that mapping
  - a run shows every unit spec passing with all the setups applied to all of them
- Not when: no case yet.
- Source: the change that regroups the host, sandbox and protocol apps by flow, design
  `docs/_plans/app-flow-folders-design.md`. A probe showed every host spec passing under one project with both setups.
- Status: active
