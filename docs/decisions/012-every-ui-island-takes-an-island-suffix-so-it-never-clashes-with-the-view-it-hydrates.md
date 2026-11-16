# D-012: Every UI island takes an `Island` suffix in its file name and its export, in every flow and not only where a name clashes, views keep their names, and a clashing binding module is renamed after its main export

- Situation: source that was filed by kind of file, with islands in one folder and the view components they hydrate in
  another, is regrouped so an island and its view sit in the same folder. The island and the view had the same file
  name and the same main export, which only the separate folders told apart. A module that binds the view to state can
  share that name too. The question is how the files and exports are told apart once they share a folder, and whether
  the fix applies to every island or only to the ones that clash.
- Options:
  - A: every island takes an `Island` suffix in its file and its export, such as a `<Name>Island.tsx` exporting
    `<Name>Island`, whether or not it clashes, and pages mount the suffixed name. Views keep their names. A clashing
    binding module is renamed after its main export, such as a `use<Name>.ts`.
  - B: the same suffix, only on the islands that clash.
  - C: the view takes a `View` suffix, and islands keep their names.
  - A per-flow `islands/` subfolder was ruled out before the question went to the owner, as a kind folder D-006
    forbids.
- Owner: option A. "Island suffix on all (Recommended)"
- Why: the owner gave no reason beyond choosing the option offered as recommended. As offered, that option gives every
  island one recognisable name shape, so a reader and a page tell an island from a view by its name alone, and a later
  island never needs a rename when a view of the same name appears. Views, which other code imports more often, keep
  their names.
- Applies when:
  - an island and the view it hydrates sit in the same folder, or may come to, and share a name
  - islands follow one naming rule across the app, so every island takes the suffix, those that clash and those that do
    not
  - a page mounts the island by its suffixed name
  - the view keeps its own name, and a binding module that clashes takes the name of its main export
- Not when: no case yet.
- Source: the change that regroups the host, sandbox and protocol apps by flow, design
  `docs/_plans/app-flow-folders-design.md`.
- Status: active
