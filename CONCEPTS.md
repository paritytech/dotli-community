# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## The protocol frame

### Protocol frame

The hidden iframe, served from the protocol origin, that brokers all chain work for every product surface open in a tab.

There is exactly one per tab, and it is shared: product surfaces never talk to a chain directly, they post requests to it. It reaches usable state in two stages — loaded, then ready — and the distinction matters because different requests need different stages. Tearing it down rejects everything waiting on readiness and orphans requests already in flight.

### Host frame

The protocol frame in its first stage: the element has loaded, but its worker has not yet announced that it can serve chain work.

Requests that only read shared authentication or shared mode storage need this stage and no more, so they are usable well before chain work is. Anything touching a chain must wait for the ready signal.

### Ready signal

The protocol frame's announcement that it can serve chain work.

It is emitted once, after presync completes, and is what separates the host frame stage from a fully ready protocol frame. Callers waiting on it are rejected together if the frame is torn down first.

### Presync

The initial chain sync a protocol frame's worker performs before emitting its ready signal.

Its duration is what makes readiness slow on a cold start. The allowance for waiting on the ready signal is deliberately set above the worker's own allowance for presync, so the outer wait cannot expire while the inner sync is still legitimately progressing.

## Requests

### Request budget

The single time bound a protocol request promises its caller, measured from the moment the request is made and covering every wait it performs.

One budget spans waiting for the frame to load, waiting for readiness, and waiting for a reply — it is not a bound on the reply alone, and it is not added on top of the frame's own allowances. Some methods are deliberately exempt because they wait on chain sync rather than on a peer, and an exempt method is bounded only by the frame's allowances. A budget is disarmed the moment its request settles.

### Timeout phase

Which wait consumed a request budget: loading the frame, waiting for readiness, or waiting for a reply.

Recorded when the budget expires rather than inferred afterwards, so it names the wait actually in progress. A frame-level failure that surfaces before the budget expires is reported as itself, not as a phase — the phase describes a request that ran out of its own time.

## Chain access

### Remote chain connection

A JSON-RPC channel between a sandboxed app and a chain, brokered through the protocol frame.

Messages sent before the connection is established are queued rather than rejected, so a connection that never establishes looks unresponsive rather than failed until its budget expires. Each connection is independent and carries its own identity. Tearing down the protocol frame does not close them: a send on a connection that had established is answered with an error, while one that never established keeps queueing.

## Flagged ambiguities

- "Host frame" and "protocol frame" had been used interchangeably for the same iframe — they name two readiness stages of one element, not two elements. Use host frame for loaded-only and protocol frame for ready.
