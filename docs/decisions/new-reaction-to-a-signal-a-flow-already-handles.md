# A new reaction to a signal an existing flow already handles

A developer adds a new reaction to something a lower layer already publishes, such as a final failure. An existing flow,
often driven by a state machine, already turns that signal into one of its outcomes, such as a fallback screen with a
manual action like a reload. The new reaction does that action, or something close to it, on its own in some cases, such
as an automatic recovery with a limit. The question is whether the new reaction lives in a module of its own that
subscribes to the signal beside the flow, or becomes part of the flow.

## How to resolve

1. Find the place where the existing flow already decides what to do with the signal, such as the state machine's
   transition into its failure outcome.
2. Add the new reaction there as another outcome of the flow, chosen beside the existing one by the condition that
   tells them apart. When it performs an action the user waits on, shape it as
   [machine-outcome-with-a-visible-wait](machine-outcome-with-a-visible-wait.md) says.
3. Keep the existing outcome as the path taken when the new reaction may not act.
4. Add no separate module, subscriber or wiring for the new reaction.

The owner's reason: the new reaction is one more outcome of the flow, and a separate module adds modularity nothing
needs. When the owner asks for the smallest affected area, that means the smallest change, not the smallest isolated
module.

## Example

```ts
// The flow's machine decides the new outcome where it already decides the failure screen.
onFailure(error) {
  if (canAutoRetry(error)) return { state: 'retrying' };
  return { state: 'failed', error };
}
```

Not this:

```ts
// A separate module subscribes beside the flow, which stays untouched.
link.$fatal.subscribe(error => showRetryScreen(error));
link.$fatal.subscribe(error => autoRetry.handle(error));
```

## Cases

- An automatic reload on a protocol version mismatch, at most once per build, joined a page whose load flow already
  showed a failure screen with a reload button. The owner first left the choice open with the smallest affected area as
  the priority, then rejected a separate page-wide subscriber and made the reload an outcome of the load state machine,
  keeping the screen when the reload may not run. (docs/_plans/mismatch-reload-design.md)

Status: active
