# D-006: A flow folder in an app stays flat, and one above about 30 source files splits into sub-flow folders named for what the code does, never into folders by kind

- Situation: an app's source is grouped into one folder per flow. The question is how the files inside one flow folder
  are arranged: all side by side, or grouped into subfolders, and if grouped, whether by kind of file (views, state and
  the like) or by what the code does. It also covers how subfolders of one flow may import each other.
- Options:
  - A: flat. Every file of the flow sits in the flow folder, specs beside their module.
  - B: fixed kind subfolders in every flow (such as `ui/`, `state/`), even small ones.
  - C: flat by default, and a flow above a size threshold (about 30 source files) splits into sub-flow folders named for
    what the code does, not by kind. Sub-flow folders of one flow import each other freely. Only the flow's `index.ts`
    faces outward.
  - D: flat by default, and a flow above a size threshold moves its views into one `ui/` subfolder.
- Owner: option C. "Flat, split by sub-flow (Recommended)"
- Why: the owner gave no reason beyond choosing the option offered as recommended. As offered, that option keeps a small
  flow in one folder with specs beside their modules, and splits a large one by what its parts do rather than by file
  kind, while the flow's single public surface stays its `index.ts`.
- Applies when:
  - an app's source is grouped into one folder per flow, and the question is how files are arranged inside one flow
  - a flow at or under about 30 source files: every file sits flat in the flow folder, specs beside their module
  - a flow above about 30 source files: it splits into sub-flow folders named for what the code does, never kind
    folders such as `ui/` or `state/`. Sub-flow folders of the same flow import each other freely, and code outside
    the flow still imports only the flow's `index.ts`
- Not when: no case yet.
- Source: the change that regroups the host, sandbox and protocol apps by flow, design
  `docs/_plans/app-flow-folders-design.md`.
- Status: active
