# @dotli/transport

A generic, bi-directional transport between documents. A schema author describes calls, streams and events in plain
TypeScript. The library moves them across a frame and owns correlation, cancellation and failure.

## Design

- A codec is an opaque value built from two plain functions, one that turns a value into bytes and one that turns bytes
  back. Code outside the library cannot read it, so the wire format stays a private detail.
- A schema nests traits, then methods, then a request or a subscription. A request carries one payload and is answered
  with a `Result`. A subscription starts with one payload, receives values, and ends with an interrupt that is a
  `Result` or with a stop that carries nothing. Each payload has its own codec.
- Wire ids are positions: a trait's id is its place in the schema and a method's id is its place in its trait. Defining
  the schema fixes them, so new traits and methods go at the end. A schema holds up to 255 traits of up to 256 methods
  each, since the library keeps one trait id for itself, and a version from 0 to 255.
- A trait or method name cannot be an integer such as `"3"`. JavaScript lists such keys first, so its id would not be
  its written place.
- The schema is opaque. Its names and payload types are read through type helpers, and nobody writes a type argument.
- A call returns a `Result`. Its error side is a `CallError`, tagged by `tag`: the handler's own `Domain` error, plus
  the library's `Denied`, `Unsupported`, `MalformedFrame`, `HostFailure` and `Cancelled`. `Cancelled` is raised by the
  caller's own side and never reaches a handler.

## Public API

### `.`

- `codec(encode, decode)` wraps two functions as a `Codec<T>`. `none` is the codec of an empty payload and refuses any
  byte on decode.
- `Result<T, E>` with `ok()` and `err(error)`.
- `CallError<E>` with the constructors `domain`, `denied`, `unsupported`, `malformedFrame`, `hostFailure` and
  `cancelled`.
- `request({ request, response, error? })` declares a request. `error` is the method's own error type and defaults to
  `never`. It returns a `RequestDef`.
- `subscription({ start, receive, interrupt? })` declares a subscription. `interrupt` is the method's own end reason and
  defaults to `never`. It returns a `SubscriptionDef`.
- `defineSchema({ version, hello?, traits })` checks the record, fixes the wire ids and returns a `Schema`. `hello` is
  the codec of the value each side sends in the handshake. It throws on a version outside 0 to 255, more than 255
  traits, more than 256 methods in a trait, or an integer-like trait or method name. `Traits` is the type of the record
  it takes.
- Type helpers over a schema `S`:
  - `TraitName<S>`, `MethodName<S, T>`, `RequestMethodName<S, T>` and `SubscriptionMethodName<S, T>` name its parts.
  - `MethodTypes<S, T, M>` is what each side of a method sends and receives. For a request of `P`, `R` and `E` it is
    `{ request: P; response: Result<R, CallError<E>> }`. For a subscription of `St`, `V` and `I` it is
    `{ start: St; receive: V; interrupt: Result<void, CallError<I>>; stop: void }`.
  - `DomainError<S, T, M>` is the method's own error, `E` or `I`.
  - `HelloOf<S>` is the handshake value, or `void` when the schema declares none.

```ts
const schema = defineSchema({
  version: 1,
  traits: {
    names: {
      owner: request({ request: label, response: owner }),
      changes: subscription({ start: none, receive: change, interrupt: failure }),
    },
  },
});
```

### `./testing`

Test helpers for code that uses the library. Empty for now.
