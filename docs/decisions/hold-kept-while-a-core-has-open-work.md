# A hold is kept while a core has open work

A developer writes the host callback adapter that answers a protocol core's begin and end calls, such as a product
starting and finishing an operation. While any begun piece of work is still open, the adapter takes a page-wide hold,
such as keeping the network from pausing. The developer notices the core's runtime never calls end for work still open
when the core tears down or faults, so the hold could leak. The question is how much machinery releases it: a tracker
for the open work that the core's owner builds, carries and disposes beside its other per-core trackers, or the adapter
itself.

## How to resolve

1. Let the adapter keep the open work itself and hold while any of it is open. It takes the hold on the first open piece
   and releases it when the last one ends.
2. Release the hold when the core ends too. Take the core's end from an event the core's owner already fires when a core
   leaves, such as the abort signal it already aborts, carried on the per-core context the adapter receives. After it
   fires, a late begin takes no hold.
3. Carry nothing over to a restored core. It starts with no open work, its client begins its work again, and the hold
   comes back with it.
4. Add no tracker for the work in the core's owner, and no lifetime the owner must dispose for it.

The owner's reason: holding until the work is gone or the core is killed, and rebuilding from what the client begins
again after a restore, is enough. A tracker in the core's owner is overengineering.

## Example

```ts
function createTaskCallbacks(holdPage: () => () => void, coreEnded: AbortSignal) {
  const open = new Set<TaskId>();
  let release: (() => void) | null = null;
  const letGo = () => {
    release?.();
    release = null;
  };
  coreEnded.addEventListener('abort', () => {
    open.clear();
    letGo();
  });
  return {
    begin(id: TaskId) {
      if (coreEnded.aborted) return;
      open.add(id);
      release ??= holdPage();
    },
    end(id: TaskId) {
      open.delete(id);
      if (open.size === 0) letGo();
    },
  };
}
```

Not this:

```ts
// The core's owner builds, carries and disposes a tracker only so the adapter can pass begin and end to it.
const tasks = createOpenTaskTracker(holdPage);
const context = { ...coreContext, tasks };
onCoreLeave(() => tasks.dispose());
```

## Cases

- A product worker's operations had to hold a hidden page's network pause, and the core runtime never ends operations
  still open at teardown or on a fault. Offered the core's end as an event on the per-core context, or a per-core
  tracker the core owner builds and disposes, the owner chose the adapter holding while operations are open and letting
  go when they end or the core is killed, with a restored core starting empty. (issue #528,
  docs/\_plans/hold-network-for-worker-operations-design.md, hold-network-worker-ops)

Status: active
