# D-011: In an app with no user flows, grouped by responsibility, the folders get no `index.ts` barrel and no lint boundary, import each other by path, and a cycle between them ends by moving the file that holds it

- Situation: an app has no user flows, and its source is regrouped into one folder per runtime responsibility directly
  in `src/`, with no `features/` level. Flow folders elsewhere in the repo each have an `index.ts` barrel and a lint
  boundary. The question is whether the responsibility folders get the same barrel and boundary, and how cycles between
  the folders are handled.
- Options:
  - A: every responsibility folder gets an `index.ts` listing its public names, and the app's ESLint config enforces
    that other folders import only that file.
  - B: no barrel and no boundary. The folders import each other by path, the entry module composes them, and the few
    existing cycles between folders end by moving the single files that hold them.
  - C: no barrel, but a lint rule forbids cycles between the folders.
- Owner: option B. "No barrel, no boundary (Recommended)"
- Why: the owner gave no reason beyond choosing the option offered as recommended. As offered, that option lets the
  folders import each other by path with the entry module composing them, and ends each cycle by moving the one file
  that holds it rather than by a lint rule. The owner saw small apps whose cycles each rested on a single import of a
  metric, a log tag or a type.
- Applies when:
  - an app has no user flows and groups its source by responsibility, directly in `src/`
  - the app is small, in the case decided about 40 source files in a handful of folders of 2 to 12 files each
  - the cycles between folders are few, and each is held by a single import of a small shared value or type, such as a
    metric, a log tag or a type
  - the folders import each other by path, and the entry module composes them
- Not when: no case yet. An app grouped by user flow follows D-005 instead.
- Source: the change that regroups the host, sandbox and protocol apps by flow, design
  `docs/_plans/app-flow-folders-design.md`. The sandbox and protocol apps have no user flows, about 40 source files each
  in 7 folders of 2 to 12 files, with 5 two-way cycles each held by one import of a metric, a log tag or a type.
- Status: active
