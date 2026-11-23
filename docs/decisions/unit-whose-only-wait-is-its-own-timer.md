# A small unit whose only wait is a timer it set

A developer writes a small unit, such as a rate limiter or a debouncer, whose one phase that outlives a call is a timer
the unit set itself. It awaits nothing, waits on no remote reply and has no failure to report. The style guide's
"A lifecycle is one state value" names a timer it set among the work that puts a unit on `createStateMachine`. So does
this unit take the machine, with a reporter for its `onError`, or keep plain closures, and what shape does its state
take?

## How to resolve

1. Check what keeps a phase alive past a call. When it is only a timer the unit set, with no await, no remote reply and
   no failure path, the unit keeps plain closures.
2. Do not rebuild it on `createStateMachine`, and do not add a reporter only to give the machine an `onError`.
3. Still write its state as a discriminated union with one member per phase. What a phase owns, such as the timer and a
   held value, lives in that phase's member, never in a nullable slot or a flag beside the state.

The owner chose this without stating a reason. It keeps the machine's cost off a unit with nothing to await or fail,
while the state still names each phase as the style guide asks.

## Example

```ts
type State<Value> = { kind: 'idle' } | { kind: 'waiting'; timer: unknown; pending: { value: Value } | null };

export function createDebouncer<Value>({ waitMs, onValue, timers = realTimers }: Params<Value>) {
  let state: State<Value> = { kind: 'idle' };

  function push(value: Value): void {
    switch (state.kind) {
      case 'idle':
        state = { kind: 'waiting', timer: timers.setTimeout(flush, waitMs), pending: null };
        onValue(value);
        return;
      case 'waiting':
        state = { ...state, pending: { value } };
        return;
    }
  }
  // ...
}
```

Not this, one nullable slot standing for both phases:

```ts
let waiting: { timer: unknown; pending: { value: Value } | null } | null = null;
```

Nor a machine with idle and waiting phases and a reporter wired in only for its `onError`.

## Cases

- A latest-wins rate limiter for a landing graphic's tilt input sets its own interval timer and awaits nothing. Offered
  a rebuild on the state machine, a tagged union in closures, or closures over one nullable slot, the owner chose the
  tagged union in closures. (landing orbit gyro change, docs/_plans/orbit-gyro-design.md, slice 1, 97b326e59)

Status: active
