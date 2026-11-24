# Stories for a feature's views

A developer adds Storybook stories for a feature, often one story per view and state of a design. Some views look
different on a phone and on a desktop. Some parts are built from smaller components, such as a renderer that draws each
kind of node in a tree a product authors. The stories' plays pass. The question is how many stories to write, what each
one shows and when they are done.

## How to resolve

1. Write one story per view and state, not one per viewport. The Storybook toolbar's viewport toggle, set in the shared
   preview, switches a story between Phone and Desktop, so a story that repeats another at the other viewport goes. This
   is the same as a story that shows the same state as another story in its file (docs/code/style.md § Tests).
2. Give each component of a composite part its own isolated stories, such as each node kind a renderer draws. Do not
   cover them only with one story that renders every kind together.
3. When one module draws those components through a dispatch, such as a switch over node kinds, move each kind into its
   own module beside the dispatcher, with its own story file, and leave only the switch in the dispatcher. Do this for
   every kind, the few-line layout kinds too, not only those with logic or states. Do not keep the module whole with a
   story file per kind.
4. Open every story at both viewports and check that it renders as the view does in the app. A play that passes does not
   show that the story renders correctly. Fix or remove a broken story before the stories are presented.

The owner's reason for step 1: the toolbar toggle already switches the viewport, so a story per viewport only repeats
it. For steps 2 and 4 the owner gave no reason beyond judging stories without them as careless work. For step 3
the owner picked a module and a story file per kind without stating a reason.

## Example

```text
Not this:
  widget-panel.stories.tsx   Empty (phone), Empty (desktop), Loaded (phone), Loaded (desktop)
  tree-renderer.tsx          switch over every kind, each case drawn inline
  tree-renderer.stories.tsx  AllNodeKinds

This:
  widget-panel.stories.tsx   Empty, Loaded             (the toolbar toggles Phone and Desktop)
  tree-renderer/
    tree-renderer.tsx        the switch only
    text-node.tsx
    text-node.stories.tsx    Plain, Long
    button-node.tsx
    button-node.stories.tsx  Enabled, Disabled
    list-node.tsx            a few lines of layout, still its own module
    list-node.stories.tsx    Empty, Several
```

## Cases

- A chat panel redesign added stories for every view and state of its design canvas: separate phone and desktop stories
  of the same view, one story file that rendered every node kind of a product-authored render tree together, and panel
  stories that rendered the panel bare on the page rather than in the surface it lives in. The owner called the stories
  broken and asked for them to be fixed, with isolated stories for the renderer's components and no per-viewport
  duplicates, since the toolbar toggles the viewport. (feat/chat-panel, docs/\_plans/chat-panel-design.md)
- The same renderer drew about nine node kinds in one switch, some with real logic, such as a text field keeping its
  caret or an image with loading states, and others a few lines of markup. Asked whether each kind becomes its own
  module, the module stays whole with a story file per kind, or only the kinds with logic split out, the owner chose a
  module and a story file for every kind. (feat/chat-panel, docs/\_plans/chat-panel-design.md)

Status: active
