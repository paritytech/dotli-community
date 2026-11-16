# D-004: When an app's source is grouped by user flow, the flow folders sit under `src/features/`, and an app with no user flows keeps its responsibility folders directly in `src/`

- Situation: an app's source is regrouped into one folder per user flow, beside folders that are not flows, such as
  page entries, the shell that composes the app, and shared helpers. Some apps in the same repo have user flows and
  some have none and group by responsibility instead. The question is whether the flow folders sit under a `features/`
  folder or directly in `src/` beside the other folders, and whether every app follows the same shape.
- Options:
  - A: `src/features/<flow>/` for flows, beside `src/pages/`, `src/shell/` (entries, composition) and `src/kit/`
    (shared helpers). Apps with no user flows use responsibility folders directly in `src/`.
  - B: every flow or responsibility folder directly in `src/<flow>/`, beside `src/pages/`, `src/shell/` and `src/kit/`,
    in every app.
  - C: `src/features/<flow>/` in every app, apps with no user flows included.
- Owner: option A. "Host features/, others flat (Recommended)"
- Why: the owner gave no reason beyond choosing the option offered as recommended. As offered, that option separates the
  flow folders from the page, shell and shared folders in the app that has user flows, and adds no `features/` level to
  an app whose folders are responsibilities rather than flows.
- Applies when:
  - an app's source is grouped into one folder per user flow, beside page, shell or shared-helper folders: the flows go
    under `src/features/<flow>/`
  - an app has no user flows and groups its source by responsibility: those folders sit directly in `src/`, with no
    `features/` level
- Not when: no case yet.
- Source: the change that regroups the host, sandbox and protocol apps by flow, design
  `docs/_plans/app-flow-folders-design.md`. The host app has user flows. The other two do not.
- Status: active
