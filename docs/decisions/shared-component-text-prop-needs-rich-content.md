# A shared component's text prop needs rich content

A developer uses a shared component from the UI package that draws its own chrome around a piece of text it takes as a
string prop, such as a drawer whose head row draws a title beside its standard close button. One consumer needs more
than text in that place, such as a back button and a small picture before a name, and what it shows changes with the
consumer's state. The consumer cannot drop the component for plain parts, since it needs the component's own behaviour.
The question is whether to add a second prop beside the text, such as a leading element drawn before the string, or a
prop that replaces the text while the string stays for another use, or to widen the one prop.

## How to resolve

1. Keep the one prop the component already has, under its name.
2. Widen its type from a string to any JSX node, so a consumer passes a string or its own markup.
3. Let the consumer change what it passes as its state changes. The component draws whatever it is given in the same
   place.
4. Do not add a second prop beside it or one that replaces it, and do not split what the prop drew into a slot per part.

The owner's reason: one stable prop that takes any JSX node is the simple answer, and a second prop overcomplicates the
component.

## Example

```tsx
// The drawer keeps one title prop, widened to a node.
type SlideOverProps = { title: JSX.Element; onClose: () => void; children: JSX.Element };

<header class={s['head']}>
  <h2 id={titleId}>{props.title}</h2>
  <CloseButton onClick={props.onClose} />
</header>;

// A consumer passes text in one state and its own markup in another.
<SlideOver title={thread() ? <><BackButton onClick={leave} /><Avatar of={thread()} />{thread().name}</> : 'Messages'} … />
```

Not this:

```tsx
<SlideOver title="Ada" lead={<><BackButton /><Avatar /></>} />  // a second prop drawn before the string
<SlideOver title="Ada" head={<ThreadHead />} />                 // a prop that replaces the text, the string kept aside
```

## Not when

The need is met without the shared component, from plain parts the package already has, such as a list of rows that
each open a detail. Then build from those parts and leave the component as it is, as
[list-row-opens-a-detail-beneath-it](list-row-opens-a-detail-beneath-it.md) says.

## Cases

- A responsive drawer, a side panel on wide screens and a bottom sheet on a phone, took only a string title that was
  also the dialog's accessible name. A chat consumer needed a back button and a letter avatar before a name in the head
  row in some states and the plain title in others. Offered a leading element prop or a replacing head prop, the owner
  chose neither and widened the one title prop to take any JSX node. (design `docs/_plans/chat-head-in-drawer-design.md`,
  branch `feat/chat-figma-design`)

Related: [markup-in-a-shared-components-head-row](markup-in-a-shared-components-head-row.md), for how large the
consumer's markup may be.

Status: active
