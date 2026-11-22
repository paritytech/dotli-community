# A state machine outcome that performs an action with a visible wait

A developer adds an outcome to a flow driven by a state machine, such as a page load. The outcome performs an action the
user waits on, such as reloading the page, often in place of an existing outcome like a failure screen. The design
first decides and performs the action inside an existing helper or transition, such as the one that shows the failure
screen, so the outcome has no state of its own. The question is how the outcome is shaped in the machine.

## How to resolve

1. Give the outcome a state of its own in the machine, named for what it does, such as `reloading`.
2. Enter that state where the machine decides the outcome, beside the outcome it replaces.
3. Perform the action in the state's side effect, not in the helper or transition that chose it.
4. Let the view show a screen for that state, such as a preparation screen, while the side effect runs.

The owner's reason: with a state of its own and the action in a side effect, the page can show a preparation screen and
perform the action at the same time.

## Example

```ts
// The outcome is a state, and its side effects show a screen and run the action at once.
onFailure(error) {
  if (mayRefresh(error)) return { state: 'refreshing' };
  return { state: 'failed', error };
}

effects: {
  refreshing: [showPreparingScreen, refreshPage],
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
```

## Cases

- An automatic reload on a protocol version mismatch replaced the load's update screen. The design first chose between
  the reload and the screen inside the helper that shows the screen. The owner asked for a `reloading` state whose side
  effects show a preparation screen and reload the page. (docs/_plans/mismatch-reload-design.md)

Related: [new-reaction-to-a-signal-a-flow-already-handles](new-reaction-to-a-signal-a-flow-already-handles.md) places
such an outcome in the flow rather than in a module of its own.

Status: active
