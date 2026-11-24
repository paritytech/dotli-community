# An existing unit needs a variant or another value

A shared unit already does a job through one call. It may be a state machine that runs effects, or a helper that
listens to one source of events and reports one value per frame. A consumer needs a little more from it:

- the same work done slightly differently, where the difference is one aspect only, such as when it runs or which
  event ends it
- the same work reporting a second value from the same events, such as the other pointer axis

A second call, a second runner or a sibling helper with its own listener looks like the quick way. So does a parameter
that picks which value to read, with one call per value.

## How to resolve

1. Name what differs: one aspect of how the work runs, or one more value the same work can report.
2. For a different way to run, add the aspect as an option on the existing call, handled by the same machinery, and let
   every wrapper of the call pass the option through.
3. For another value, widen the existing unit so one listener and one frame report every value the consumer needs,
   together in one report. Rename the unit when its name names the one value it used to report, and let the consumer
   take all the values from that one report.
4. Add no second call or second runner beside the existing one. Add no sibling unit with its own listener either, and no
   parameter that picks the value with one call per value.

The owner chose this in each case without stating a reason. It keeps one entry point and one runner, so wrappers change
only to pass the option on, and one listener and one frame per source of events, so the values arrive together.

## Example

A variant of how the work runs:

```ts
emit(effect); // runs right after the step that emitted it
emit(effect, { after: 'drain' }); // the variant, run by the same runner

const emitLogged = (effect: Effect, options?: EmitOptions) => {
  log.event('emit', effect.type);
  emit(effect, options); // a wrapper passes the option through
};
```

Another value from the same events:

```ts
const stop = followScroll(({ x, y }) => view.setOffset(x, y)); // one listener, one report per frame with both
```

Not this:

```ts
emitAfterDrain(effect);
createMachine({ run, runAfterDrain });

const stopY = followScrollY((y) => view.setY(y));
const stopX = followScrollX((x) => view.setX(x));
followScroll('x', (x) => view.setX(x)); // generic, one call per value
```

## Not when

The variant would only place a shared surface against something other than its trigger, such as a new named placement
that aligns to an enclosing bar's edge. Add no variant. The surface sits against its trigger, as
[a surface is placed against its trigger](surface-placed-against-its-trigger.md) says.

## Cases

- A state machine's effects needed a phase that runs once every queued step has finished. It became an option on the
  existing emit. (PR #477)
- A landing graphic tilted with the pointer's vertical position through a helper that reported that axis once per
  frame. To also turn the graphic with the horizontal position, the helper became one pointer follower reporting both
  axes per frame. (branch feat/orbit-pointer-turn)
- A shared floating layer needed to run its own closes for a popover anchored to a control that cannot invoke it. It
  gained an option rather than a second layer, as
  [light-dismiss-popover-closes-when-it-should-not](light-dismiss-popover-closes-when-it-should-not.md) says.
  (architecture change "Action group More: Listbox on wide screens", docs/\_plans/more-listbox-design.md)
- A shared modal surface had to keep its content on screen while it slid out after a close. Offered the package's
  presence helper as the sibling layers use it, ending the exit on a timer of the exit's length, the same helper with
  an option to end the exit on the surface's real `transitionend`, or children mounted for good with a context telling
  them whether the surface is shown, the owner chose the presence helper with the `transitionend` option.
  (docs/\_plans/chat-panel-design.md, feat/chat-panel)
- Counter-case: a shared tooltip card had to drop from an enclosing bar's edge rather than its trigger's. Offered a new
  named placement reading the bar's published custom property, the owner added no variant and kept the card against
  its trigger. (docs/\_plans/floating-placement-design.md, feat/floating-ui)

Status: active
