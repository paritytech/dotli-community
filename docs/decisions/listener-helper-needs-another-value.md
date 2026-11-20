# A listener helper needs another value from the same events

A developer extends a small helper that listens to one source of events, such as pointer moves, throttles to one report
per animation frame and reports one value derived from them, such as the position on one axis. A view now needs a
second value from the same events, such as the other axis. The question is whether to add a sibling helper for the new
value, make the helper generic over which value it reads and call it twice, or widen the one helper.

## How to resolve

1. Widen the existing helper so one listener and one frame report every value the view needs, together in one report.
2. Rename the helper so its name stops naming the one value it used to report.
3. Let the view take all the values from that one report.
4. Add no sibling helper with its own listener and frame, and no parameter that picks the value with one call per value.

The owner chose this without stating a reason. It keeps one listener and one frame per source of events, so the values
arrive together.

This differs from [existing-call-needs-a-variant](existing-call-needs-a-variant.md), where a call does the same work in a
slightly different way. Here the work is the same and the report grows.

## Example

```ts
// Before: one helper per value, each with its own listener and frame.
const stopY = followScrollY((y) => view.setY(y));
const stopX = followScrollX((x) => view.setX(x));

// Or one generic helper called once per value.
followScroll('y', (y) => view.setY(y));
followScroll('x', (x) => view.setX(x));

// After: one helper, one listener, one report per frame with both values.
const stop = followScroll(({ x, y }) => view.setOffset(x, y));
```

## Cases

- A landing graphic tilted with the pointer's vertical position through a helper that reported that axis once per
  frame. To also turn the graphic with the horizontal position, the helper became one pointer follower reporting both
  axes per frame. (branch feat/orbit-pointer-turn)

Status: active
