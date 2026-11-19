# Static page content that a runtime setting gates

A developer adds a piece of content, such as a one-line notice, to a page that is rendered to static HTML at build and
hydrates a few islands. The piece must show only when a setting the visitor picks has some property. The page reads that
setting at boot into an app store, so the store is empty at build and the build cannot know the answer. The question is
when the piece appears. It could be filled in by an island once the store settles. It could be rendered at build and
hidden once the store says no. It could also be decided at build from every value the build could offer.

## How to resolve

1. Render an empty slot at build, the same element the content will fill, so the elements around it keep their place.
2. Give the slot a small island that reads the store through `useStore` and renders the content only once the store says
   the property holds.
3. Accept that the content appears after hydration. Do not render it at build and hide it later, which shows it wrongly
   to a visitor whose setting lacks the property until the island runs.
4. Do not decide it at build from the values the build could offer. That answer describes the deployment, not the
   setting the visitor picked, and it turns wrong for everyone once a value without the property exists. Where the fact
   itself comes from is [fact-about-each-network](fact-about-each-network.md).

The owner chose the island that fills the slot without stating a reason beyond the trade-offs offered. Another piece of
the same page that depends on the same setting already worked this way.

## Example

```tsx
// Built HTML holds the empty slot, so the links keep their side of the row.
// <footer><p data-testid="plan-notice"></p><nav>…</nav></footer>

export function PlanNotice() {
  const plan = useStore($pickedPlan); // null at build and until boot settles
  return (
    <p data-testid="plan-notice">
      <Show when={plan()?.trial}>Trial plan: data resets each week.</Show>
    </p>
  );
}
```

Not this:

```tsx
// Rendered at build and hidden later, so it is wrong until hydration for a visitor on a paid plan.
<p data-testid="plan-notice" hidden={plan() !== null && !plan().trial}>Trial plan: data resets each week.</p>
```

## Cases

- A landing page footer held a test-network notice at one end and links at the other. The notice must show only when
  the visitor's picked network is a test network, which every network was at the time. The owner chose an island that
  fills the notice in once the store says so, over rendering it at build and hiding it, and over deciding it at build.
  The page's name input placeholder already filled in from the same store after hydration. (feat/landing-horizon,
  PR #493, docs/_plans/testnet-notice-design.md)

Status: active
