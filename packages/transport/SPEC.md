# Transport Protocol Design

## Overview

The transport is language-agnostic. All code examples are written in Rust, but authors can easily map these interfaces
into other languages.

This document defines the transport and no methods.

## General Interface

A schema declares its `version`, the type of the hello each peer sends in the handshake, and its sections in order, each
a list of methods in order. A method is a request or a subscription. Peers MUST share the schema, and the schema's
`version` MUST change with any change to its methods or their payloads.

```rust
// A request takes one payload and is answered once.
fn request(payload: P) -> Result<R, CallError<E>>;

// A subscription takes one payload, receives values, and ends with its interrupt or the caller's unsubscribe.
fn subscribe(payload: S, subscriber: Subscriber<V, I>) -> Unsubscribe;
```

A method that declares no error has an empty one, `()`. So does a subscription that declares no interrupt reason.

## Transport

Communication between peers can be implemented with any IPC protocol. The body of an IPC message is a serialized `Frame`
(byte array). The IPC implementation may vary depending on the environment.

### Provider

A provider moves bytes between two contexts and knows nothing of their meaning.

```rust
trait Provider {
  fn isCorrectEnvironment() -> bool;
  fn postMessage(message: Vec<u8>);
  fn subscribe(callback: fn(Vec<u8>)) -> fn();
  fn dispose();
}
```

`postMessage` MUST NOT deliver to the provider's own subscribers before it returns. Data that is not bytes MUST be
dropped by the provider. A transport over a provider that is not in a correct environment MUST close at once.

The provider is the trust boundary: the transport serves every peer whose bytes the provider delivers, and tells a
handler nothing of where they came from. The library ships a window provider, which admits one peer window at a fixed
origin or at the first origin a predicate allows and delivers nothing from any other origin, and a port provider, which
speaks over a message port.

### Serialization

Messages are serializable structs that can be passed between peers.

Message serialization is built on [SCALE codec](https://github.com/paritytech/parity-scale-codec). All examples in this
proposal skip SCALE codec derive implementation calls, but they are implied. The field order of structs and enums
matters. `Result` is also treated as a serializable enum.

#### Note on SCALE codec

Frames use plain SCALE codec, as [scale-ts](https://github.com/unstoppablejs/unstoppablejs/tree/main/packages/scale-ts)
implements it. A `Vec<u8>` marked _rest_ below has no length prefix and takes every byte to the end of the frame.

### Interface (ABI)

Each message can be defined as:

```rust
struct Frame {
  id: u32,
  body: Body
}

enum Body {
  handshakeOffer(HandshakeOffer),
  handshakeResponse(Result<Vec<u8> /* rest */, Versions>),
  failed(Failure),
  call(Call)
}

struct HandshakeOffer {
  versions: Versions,
  hello: Vec<u8> /* rest */
}

struct Versions {
  wire: u8,
  schema: u8
}

struct Call {
  sectionId: u8,
  methodId: u8,
  message: Message
}
```

`handshakeOffer` and `handshakeResponse` are the handshake. `failed` answers a call with a failure of the transport's
own. `call` carries a message of a method. `wire` is the version of the transport's own wire: `Frame`, `Failure`,
`CallError` and the handshake. It is `1`. `schema` is the schema's version. The layout of `Frame`, `handshakeOffer` and
`handshakeResponse` MUST NOT change between versions, and `wire` comes first in `Versions`, so a peer of any version
reads the versions it refuses.

`Message` is the method's own enum of **actions**. Ids MUST follow the order of the schema: `sectionId` is the section's
place in the schema and `methodId` the method's place in its section. New sections and methods MUST go at the end. A
schema holds up to 256 sections of up to 256 methods each, and each method sits in one place only.

Actions MUST be derived from methods using the following algorithm:

- For request functions, there should be two messages:
  - Request
    - Name: `request`
    - Argument: the payload `P`
  - Response
    - Name: `response`
    - Argument: `Result<R, CallError<E>>`
- For subscriptions, there should be four different messages:
  - Subscribe
    - Name: `start`
    - Argument: the payload `S`
  - Receive
    - Name: `receive`
    - Argument: `V`, the argument of the subscriber's `receive`
  - Interrupt
    - Name: `interrupt`
    - Argument: `I`, the method's own interrupt reason as a whole
  - Unsubscribe
    - Name: `stop`
    - Argument: none

Actions MUST be defined in the given order. A method's payload always comes last in its message, so its codec reads
exactly the payload's bytes. The transport adds nothing to `I`, so a clean end is whatever the method's type says. A
method that wants truapi's layout declares `Result<(), CallError<Reason>>` as its `I`.

So every method's `Message` is one of two enums:

```rust
enum RequestMessage<P, R, E> {
  request(P),
  response(Result<R, CallError<E>>),
}

enum SubscriptionMessage<S, V, I> {
  start(S),
  receive(V),
  interrupt(I),
  stop,
}
```

### Rules

#### Call ids

Each peer numbers its own calls: the opener with odd ids from 1, the accepter with even ids from 2, wrapping to its
first id after the last `u32`. So a frame's id tells whose call it is about: one of the peer's own calls hears answers,
values and ends, and one of the other peer's reaches the handler.

A peer MUST answer a `request` or a `start` that comes before its handshake is over with a `failed` frame of the same
`id` carrying `HostFailure`, with the reason `The handshake is not over`, and run no handler for it. A peer MUST refuse,
with no answer, a call that comes after it closed, a message whose method is not the one its call names, and a frame
that does not decode. Nothing ever answers a `failed` frame. A message on a call the peer ended lately is a race and
MUST be dropped quietly. So MUST a `stop` for a subscription that is not running.

Ids are not reused while a call is running. As truapi does, a serving peer MUST refuse, with no answer, a `request` or a
`start` whose `id` is a request still in flight, and MUST NOT run a handler for it. A `start` on the `id` of a running
subscription replaces it: the running one stops with no frame sent, and the new one starts.

A frame, a message, a hello or a `Failure` that leaves bytes unread does not decode, as truapi's `decode_all` refuses
it.

#### Requests

Each peer MUST send a response message for every request. Request and response MUST share the same `id` for matching on
each side.

When no handler serves the method, the message does not decode or the handler fails, the serving peer MUST answer with a
`failed` frame of the same `id`, carrying `Unsupported`, `MalformedFrame` or `HostFailure`. A request that leaves bytes
unread is answered `MalformedFrame`. A response that does not decode fails the call locally with an error whose cause is
why, as truapi's client and host-api fail it, and is no `CallError`.

A caller MAY abort a request. It then settles locally as `Cancelled`, the serving peer is not told, and a late answer is
ignored.

#### Subscription

`start`, `receive`, `interrupt` and `stop` calls MUST share the same `id` for matching inside subscription handlers.

When a subscription starts, the consumer MUST notify the provider with a `start` message. When the consumer wants to
unsubscribe, it MUST send a `stop` message. The provider MUST send data updates with a `receive` message. The provider
ends the subscription with an `interrupt` message carrying the subscription-specific reason. The consumer MAY react to
an `interrupt` message by notifying the application layer. Nothing follows an `interrupt` or a `stop`.

The serving peer MUST end a subscription with a `failed` frame of the same `id` in place of an `interrupt` when no
handler serves the method or the `start` does not decode (`Unsupported` or `MalformedFrame`), and when the handler
throws or a value cannot be encoded (`HostFailure`). The consumer hears it as the subscription's end.

Each subscription method declares its own interrupt payload type `I`. Subscriptions that do not need to communicate a
reason default `I` to `()`. The interrupt payload type is orthogonal to the type `receive` takes, and reaches the
subscriber's `interrupt`.

A `receive` that does not decode ends the subscription with `MalformedFrame`, and the consumer MUST send `stop`, since
what was lost may be a value. An `interrupt` that does not decode ends it with `MalformedFrame` too, and the consumer
MUST NOT send `stop`, since nothing follows an `interrupt`. A message whose action cannot be read counts as a `receive`.

The `Subscriber` interface depends on the implementation, but a generic interface may look like this:

```rust
struct Subscriber<V, I = ()> {
  receive: fn(V),
  interrupt: fn(I),
  fail: fn(Failure),
  close: fn(Error)
}

// What subscribing returns. It sends `stop` and calls no listener.
type Unsubscribe = fn();
```

`interrupt` hears only the provider's own `interrupt` message. `fail` hears every failure of the transport's own: a
`failed` frame, `Cancelled` once the consumer aborts, and `MalformedFrame` when a message does not decode. `close` hears
the one local end, the transport closing. Exactly one of them is called, once. `unsubscribe` calls none of them.

#### Forwarding

A peer MAY forward calls of methods to another peer of the same schema. It numbers the forwarded calls itself, as calls
of its own on the other link, and passes every message as it is, in both directions. A peer's `stop` that does not read
whole is refused, as a served subscription refuses it, and not passed. A forwarded call is ordinary frames on both
links, so each link keeps its own rules. When the link it forwards to closes under a forwarded call, the forwarding peer
answers the call with a `failed` frame carrying `HostFailure`. When the forwarding peer closes, or a `start` replaces a
forwarded subscription, it posts a `stop` of its own for that subscription on the other link, which is still open.

#### Closing

A transport closes when its provider is not in a correct environment, the handshake fails or times out, the versions
differ, its provider throws on a post, or its owner disposes it. Every pending and later request then fails with that
error, and every subscription hears it once through `close`. A provider that throws on a post closes the transport with
the provider's error, as truapi's client does.

A transport that closes, for any reason, MUST post no frame, as truapi's runtime posts none once disposed: no `failed`
frame for the calls it serves and no `stop` for the subscriptions it made. Each subscription it serves stops locally,
and each request it serves is never answered. A peer learns that the other closed from its provider or a liveness check
of its own.

## API Sections

The transport defines no API sections. A schema does. What follows is shared by every method.

### Common Interfaces

```rust
enum Failure {
  Denied,
  Unsupported,
  MalformedFrame { reason: str },
  HostFailure { reason: str },
  Cancelled
}

enum CallError<E> {
  Domain(E),
  Denied,
  Unsupported,
  MalformedFrame { reason: str },
  HostFailure { reason: str },
  Cancelled
}
```

`CallError` is truapi's: `Domain` is the method's own error, and the rest are the transport's own failures, in the order
of `Failure`. A `failed` frame carries a `Failure`, so the transport answers any call whatever the method's error is.
`Cancelled` is raised by the caller's own side when it aborts, and never crosses the wire. A `reason` built from an
error is `"<name>: <message>"`, at most 500 characters, so the peer keeps the error's name.

### Handshake

One peer opens the handshake and the other accepts it. Handshake implementations CAN include a timeout, 10 seconds by
default as in host-api and truapi, after which the connection is marked as failed and fails with a `Timeout` error. An
owner that bounds the wait itself MAY set none.

The opener starts the handshake with its first call or its first wait for the handshake, as host-api does, unless it
started earlier. It MUST post a `handshakeOffer` frame with id `0`, carrying its `Versions`, the transport's `wire`
version first, then the schema's, and its hello, and post a fresh one every 50 ms by default until it is answered or the
timeout passes, since the accepter may not be listening yet. The accepter MUST answer every `handshakeOffer` with a
`handshakeResponse` of the same `id`. Its answer is `Ok(hello)` when both versions match and `Err(Versions)` with its
own otherwise, and every later answer repeats the first. A hello is decoded only at the same versions, since another
version's may not decode. A mismatch of either version closes both peers, and the accepter answers no offer once closed.

A successful handshake MUST come before any call. Calls made before it wait and go out in call order once it succeeds. A
`request` or a `start` of the peer that comes before it is answered with `HostFailure`, as the call ids rules say.

```rust
enum HandshakeErr {
  Timeout,
  UnsupportedProtocolVersion { ours: Versions, theirs: Versions }
}
```

`HandshakeErr` is local to each peer and never crosses the wire.
