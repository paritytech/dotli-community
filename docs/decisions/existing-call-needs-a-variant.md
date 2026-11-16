# An existing call needs a variant

A shared primitive, such as a state machine, already does something through one call. A consumer needs it done slightly
differently, and the difference is one aspect only, such as when it runs. What is done and what does it stay the same.
A second call or a second runner for the variant looks like the quick way.

## How to resolve

1. Name the one aspect that differs.
2. Add it as an option on the existing call, handled by the same machinery.
3. Let every wrapper of the call pass the option through.
4. Add no second call and no second runner.

The owner chose this without stating a reason. It keeps one entry point and one runner, so wrappers change only to pass
the option on.

## Example

```ts
// The existing call: the effect runs right after the step that emitted it.
emit(effect);

// The variant is an option on the same call, run by the same runner.
emit(effect, { after: 'drain' });

// A wrapper passes the option through.
const emitLogged = (effect: Effect, options?: EmitOptions) => {
  log.event('emit', effect.type);
  emit(effect, options);
};
```

Not this:

```ts
emitAfterDrain(effect);
createMachine({ run, runAfterDrain });
```

## Cases

- A state machine's effects needed a phase that runs once every queued step has finished. It became an option on the
  existing emit. (PR #477)

Status: active
