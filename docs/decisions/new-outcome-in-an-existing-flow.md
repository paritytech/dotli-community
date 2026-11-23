# A new outcome in an existing flow

A developer adds a reaction to something a lower layer already publishes, such as a final failure. An existing flow,
often driven by a state machine such as a page load, already turns that signal into one of its outcomes, such as a
failure screen with a manual action like a reload. The new reaction does that action, or something close to it, on its
own in some cases, such as an automatic recovery with a limit. It is often an action the user waits on, such as
reloading the page. Several shapes look possible:

- a module of its own that subscribes to the signal beside the flow
- deciding and performing the action inside an existing helper or transition, such as the one that shows the failure
  screen, so the outcome has no state of its own
- a handler that makes a call with a side effect to choose the outcome, such as claiming a one-time permission in
  storage, before it emits its next state, against the style rule that a handler emits its next state before it calls
  out (docs/code/style.md § A lifecycle is one state value)

The question is where the reaction lives and how it is shaped in the machine.

## How to resolve

1. Find the place where the existing flow already decides what to do with the signal, such as the state machine's
   transition into its failure outcome.
2. Add the new reaction there as another outcome of the flow, chosen beside the existing one by the condition that
   tells them apart. Add no separate module, subscriber or wiring for it.
3. Keep the existing outcome as the path taken when the new reaction may not act.
4. Give the new outcome a state of its own in the machine, named for what it does, such as `reloading`, and perform the
   action in that state's side effect, not in the helper or transition that chose it.
5. When choosing the outcome needs a call with a side effect, such as a claim, keep that call out of the handler too.
   Enter the outcome state first and make the call in its side effect. When the call refuses, the side effect sends an
   event back, and the machine moves to the outcome it replaces, such as the failure screen.
6. When the user waits on the action, let the view show a screen for that state, such as a preparation screen, while
   the side effect runs, and hold the action for a short wait after the screen shows, about a second, so the user sees
   the message before the action takes the page away.

The owner's reason: the new reaction is one more outcome of the flow, and a separate module adds modularity nothing
needs. When the owner asks for the smallest affected area, that means the smallest change, not the smallest isolated
module. With a state of its own and the action in a side effect, the page can show a preparation screen and perform the
action at the same time, and the short wait lets the user read that screen. The owner kept the style rule rather than
add an exception for a decision with a side effect, and moved the decision into the side effect instead.

## Example

```ts
// The flow's machine decides the new outcome where it already decides the failure screen.
onFailure(error) {
  if (isRefreshable(error)) return { state: 'refreshing', error };
  return { state: 'failed', error };
}

// The outcome's side effect claims, shows the screen, waits briefly and acts,
// or sends an event back that falls to the outcome it replaces.
effects: {
  refreshing: ({ error }, update) => {
    if (!refreshPermit.claim()) return update({ type: 'refreshRefused', error });
    showPreparingScreen();
    setTimeout(refreshPage, 1000);
  },
  failed: [showFailureScreen],
}
```

Not this:

```ts
// A separate module subscribes beside the flow, which stays untouched.
link.$fatal.subscribe((error) => autoRefresh.handle(error));

// The helper that shows the failure screen decides and runs the action itself, with no state for it.
function showFailureScreen(error) {
  if (mayRefresh(error)) return refreshPage();
  render(failureScreen(error));
}

// The handler claims, a call out with a side effect, before it emits its next state.
onFailure(error) {
  const refreshes = isRefreshable(error) && refreshPermit.claim();
  return refreshes ? { state: 'refreshing' } : { state: 'failed', error };
}
```

## Cases

- An automatic reload on a protocol version mismatch, at most once per build, joined a page whose load flow already
  showed a failure screen with a reload button. The owner first left the choice open with the smallest affected area as
  the priority, then rejected a separate page-wide subscriber and made the reload an outcome of the load state machine,
  keeping the screen when the reload may not run. (docs/_plans/mismatch-reload-design.md)
- The same reload replaced the load's update screen. The design first chose between the reload and the screen inside
  the helper that shows the screen. The owner asked for a `reloading` state whose side effects show a preparation screen
  and reload the page. (docs/_plans/mismatch-reload-design.md)
- The same reload claimed a once-per-build permission in session storage before the handler emitted its state, which a
  review flagged against the style rule. The owner kept the rule, moved the claim and the reload into the `reloading`
  state's side effect with a fallback to the failure outcome when the claim does not hold, and asked the reload to wait
  about a second so the user sees the reloading message. (docs/_plans/mismatch-reload-design.md,
  docs/_reviews/mismatch-reload-review.md finding M1)

Status: active
