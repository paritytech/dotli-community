# Cap how often a stream of readings reaches state

A page component turns a fast stream of input readings, such as sensor or pointer events, into rendered state, and must
cap it at a few updates per second with the latest reading winning. More than one input source may feed the same state.
The project bans hand-rolled timers and concurrency limits and points at `createAsyncTaskPool`. So where does the cap
live? It could go on the pool or into a shared helper. Each source could cap itself, or the feature could hold a small
limiter of its own.

## How to resolve

1. Write one small rate limiter in the feature's folder. It keeps only the latest reading and emits on the leading and
   the trailing edge of each interval.
2. Run it on the injected timers seam the feature already takes, so a unit test drives the interval with fake timers.
3. Feed every source into that one limiter, where the sources meet the state. Each source becomes a plain mapper from
   its event to a reading and holds no timing of its own.
4. Do not build the cap on `createAsyncTaskPool` with a task that waits out the interval. Do not add a generic throttle
   to the shared package for it, and do not let each source skip frames on its own.

The owner chose this without stating a reason. It keeps the timing in one place, so the state is capped once however
many sources feed it.

## Example

```ts
// features/compass/createLatestLimiter.ts
export const createLatestLimiter = <T>(perSecond: number, emit: (value: T) => void, timers: Timers) => {
  // keeps the latest value, emits on the leading and trailing edge of each interval
};

// features/compass/startCompass.ts
const limit = createLatestLimiter<Heading>(10, setHeading, timers);
const stopTilt = onTilt((event) => limit(headingFromTilt(event)));
const stopDrag = onDrag((event) => limit(headingFromDrag(event)));
```

Not this:

```ts
const pool = createAsyncTaskPool({ size: 1 });
pool.run(async () => {
  await delay(100);
  setHeading(latest);
});

const stopTilt = onTilt(skipFramesUntil(100, (event) => setHeading(headingFromTilt(event))));
```

## Cases

- A landing graphic's motion follows device tilt, fed by two input sources and capped at a few updates per second. It
  got one local latest-wins limiter on the injected timers, fed by both sources. The pool, a shared throttle and
  per-source frame skipping were offered and passed over. (landing orbit gyro change, docs/_plans/orbit-gyro-design.md)

Status: active
