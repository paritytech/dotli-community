---
title: 'Transport Protocol Design'
type: design
status: accepted
created: 2026-10-19
---

# Transport Protocol Design

## Overview

The transport is language-agnostic. All code examples are written in Rust, but authors can easily map these interfaces
into other languages.

This document defines the transport and no methods. The examples use an imaginary schema.

## General Interface

A schema nests sections, then methods. A method is a request or a subscription. Peers MUST share the schema, and the
schema's `version` MUST change with any change to its methods or their payloads.

```rust
// Imaginary schema, version 1.
mod names {
  fn owner(
    label: str
  ) -> Result<Owner, CallError<OwnerErr>>;

  fn changes_subscribe(
    callback: fn(Change)
  ) -> Subscriber<ChangesErr>;
}

mod chain {
  fn send(
    connectionId: str,
    message: str
  ) -> Result<(), CallError<()>>;
}
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
  open(Open),
  accept(Result<Vec<u8> /* rest */, VersionInfo>),
  failed(Failure),
  call(Call)
}

struct Open {
  version: u8,
  hello: Vec<u8> /* rest */
}

struct VersionInfo {
  version: u8
}

struct Call {
  sectionId: u8,
  methodId: u8,
  message: Message
}
```

`open` and `accept` are the handshake. `failed` answers a call with a failure of the transport's own. `call` carries a
message of a method. The layout of `Frame`, `open` and `accept` MUST NOT change between versions, so a peer of any
version reads the version it refuses.

`Message` is the method's own enum of **actions**. Ids MUST follow the order of the schema: `sectionId` is the section's
place in the schema and `methodId` the method's place in its section. New sections and methods MUST go at the end. A
schema holds up to 256 sections of up to 256 methods each, and each method sits in one place only.

Actions MUST be derived from methods using the following algorithm:

- For request functions, there should be two messages:
  - Request
    - Name: `request`
    - Argument: `(arg1, arg2, ...)`
  - Response
    - Name: `response`
    - Argument: `Result<ReturnValue, CallError<ReturnError>>`
- For subscriptions, there should be four different messages:
  - Subscribe
    - Name: `start`
    - Argument: tuple of all arguments except callback `(arg1, arg2, ...)`
  - Receive
    - Name: `receive`
    - Argument: argument of callback function
  - Interrupt
    - Name: `interrupt`
    - Argument: `Result<(), CallError<InterruptReason>>`
  - Unsubscribe
    - Name: `stop`
    - Argument: none

Actions MUST be defined in the given order. A method's payload always comes last in its message, so its codec reads
exactly the payload's bytes.

Example:

```rust
// names.owner, at sectionId 0, methodId 0
enum OwnerMessage {
  request(str),
  response(Result<Owner, CallError<OwnerErr>>),
}

// names.changes_subscribe, at sectionId 0, methodId 1
enum ChangesMessage {
  start(()),
  receive(Change),
  interrupt(Result<(), CallError<ChangesErr>>),
  stop,
}

// chain.send, at sectionId 1, methodId 0
enum SendMessage {
  request((str, str)),
  response(Result<(), CallError<()>>),
}
```

### Rules

#### Call ids

Each peer numbers its own calls: the opener with odd ids from 1, the accepter with even ids from 2, wrapping to its
first id after the last `u32`. So a frame's id tells whose call it is about: one of the peer's own calls hears answers,
values and ends, and one of the other peer's reaches the handler.

A peer MUST refuse, with no answer, a call that comes before the handshake, a message whose method is not the one its
call names, and a frame that does not decode. Nothing ever answers a `failed` frame. A message on a call the peer ended
lately is a race and MUST be dropped quietly.

#### Requests

Each peer MUST send a response message for every request. Request and response MUST share the same `id` for matching on
each side.

When no handler serves the method, the message does not decode or the handler fails, the serving peer MUST answer with a
`failed` frame of the same `id`, carrying `Unsupported`, `MalformedFrame` or `HostFailure`. A response that does not
decode settles the call as `MalformedFrame`.

A caller MAY abort a request. It then settles locally as `Cancelled`, the serving peer is not told, and a late answer is
ignored.

#### Subscription

`start`, `receive`, `interrupt` and `stop` calls MUST share the same `id` for matching inside subscription handlers.

When a subscription starts, the consumer MUST notify the provider with a `start` message. When the consumer wants to
unsubscribe, it MUST send a `stop` message. The provider MUST send data updates with a `receive` message. The provider
ends the subscription with an `interrupt` message: `Ok(())` for a clean end, or `Err` with the subscription-specific
reason or a failure. The consumer MAY react to an `interrupt` message by notifying the application layer. Nothing
follows an `interrupt` or a `stop`.

The serving peer MUST end a subscription with a `failed` frame of the same `id` in place of an `interrupt` when no
handler serves the method or the `start` does not decode (`Unsupported` or `MalformedFrame`), and when the handler
throws, a value cannot be encoded or the serving peer disposes (`HostFailure`). The consumer hears it as the
subscription's end.

Each subscription method declares its own interrupt payload type `I`. Subscriptions that do not need to communicate a
reason default `I` to `()`. The interrupt payload type is orthogonal to the `receive` callback type and is surfaced on
the returned `Subscriber<I>`.

A `receive` that does not decode ends the subscription with `MalformedFrame`, and the consumer MUST send `stop`, since
what was lost may be a value.

The returned `Subscriber` interface depends on the implementation, but a generic interface may look like this:

```rust
struct Subscriber<I = ()> {
  unsubscribe: fn(),
  onInterrupt: fn(fn(Result<(), CallError<I>>)),
  onClose: fn(fn(Error))
}
```

`onClose` hears the one local end, the transport closing or a `start` that could not be posted. Unsubscribing calls no
listener.

#### Closing

A transport closes when its provider is not in a correct environment, the handshake fails or times out, the versions
differ, or its owner disposes it. Every pending and later request then fails with that error, and every subscription
hears it once through `onClose`. Disposing also answers each request the peer is serving, and ends each subscription it
serves, with a `failed` frame carrying `HostFailure`, and sends `stop` for each subscription it made.

A peer leaves when its own `stop` leaves nothing it opened running and no request of its is in flight.

## API Sections

The transport defines no API sections. A schema does, as in the General Interface. What follows is shared by every
method.

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

One peer opens the handshake and the other accepts it. Handshake implementations CAN include a timeout, 5 seconds by
default, after which the connection is marked as failed and fails with a `Timeout` error.

The opener MUST post an `open` frame with id `0`, carrying the schema's `version` in `u8` and its hello, and post a
fresh one every 50 ms by default until it is answered or the timeout passes, since the accepter may not be listening
yet. The accepter MUST answer every `open` with an `accept` of the same `id`. Its answer is `Ok(hello)` when the
versions match and `Err(VersionInfo)` with its own version otherwise, and every later answer repeats the first one it
could post. A hello is decoded only at the same version, since another version's may not decode. A version mismatch
closes both peers.

A successful handshake MUST come before any call. Calls made before it wait and go out in call order once it succeeds.
Calls of the peer that come before it are refused with no answer.

```rust
enum HandshakeErr {
  Timeout,
  VersionMismatch { ours: u8, theirs: u8 }
}

type ProtocolVersion = u8;
```

`HandshakeErr` is local to each peer and never crosses the wire.
