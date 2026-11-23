# A state machine outcome that performs an action with a visible wait

A developer adds an outcome to a flow driven by a state machine, such as a page load. The outcome performs an action the
user waits on, such as reloading the page, often in place of an existing outcome like a failure screen. The design
first decides and performs the action inside an existing helper or transition, such as the one that shows the failure
screen, so the outcome has no state of its own. Or choosing the outcome needs a call with a side effect of its own, such
as claiming a one-time permission in storage, and the handler would make that call before it emits its next state,
against the style rule that a handler emits its next state before it calls out (docs/code/style.md § A lifecycle is one
state value). The question is how the outcome is shaped in the machine.

## How to resolve

1. Give the outcome a state of its own in the machine, named for what it does, such as `reloading`.
2. Enter that state where the machine decides the outcome, beside the outcome it replaces.
3. Perform the action in the state's side effect, not in the helper or transition that chose it.
4. When choosing the outcome needs a call with a side effect, such as a claim, keep that call out of the handler too.
   Enter the outcome state first and make the call in its side effect. When the call refuses, the side effect sends an
   event back, and the machine moves to the outcome it replaces, such as the failure screen.
5. Let the view show a screen for that state, such as a preparation screen, while the side effect runs.
6. Hold the action for a short wait after the screen shows, about a second, so the user sees the message before the
   action takes the page away.

The owner's reason: with a state of its own and the action in a side effect, the page can show a preparation screen and
perform the action at the same time, and the short wait lets the user read that screen. The owner kept the style rule
rather than add an exception for a decision with a side effect, and moved the decision into the side effect instead.

## Example

```ts
// The outcome is a state. Its side effect claims, shows the screen, waits briefly and acts,
// or sends an event back that falls to the outcome it replaces.
onFailure(error) {
  if (isRefreshable(error)) return { state: 'refreshing', error };
  return { state: 'failed', error };
}

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

- An automatic reload on a protocol version mismatch replaced the load's update screen. The design first chose between
  the reload and the screen inside the helper that shows the screen. The owner asked for a `reloading` state whose side
  effects show a preparation screen and reload the page. (docs/_plans/mismatch-reload-design.md)
- The same reload claimed a once-per-build permission in session storage before the handler emitted its state, which a
  review flagged against the style rule. The owner kept the rule, moved the claim and the reload into the `reloading`
  state's side effect with a fallback to the failure outcome when the claim does not hold, and asked the reload to wait
  about a second so the user sees the reloading message. (docs/_plans/mismatch-reload-design.md,
  docs/_reviews/mismatch-reload-review.md finding M1)

Related: [new-reaction-to-a-signal-a-flow-already-handles](new-reaction-to-a-signal-a-flow-already-handles.md) places
such an outcome in the flow rather than in a module of its own.

Status: active
