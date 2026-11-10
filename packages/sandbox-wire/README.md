# `@dotli/sandbox-wire`

The protocol between the host and a sandbox frame: the URL params, every message both ways, and the host's listener.

## Responsibility

- **Owns:** the param contract, the message shapes and parsers, and the host's one channel for sandbox messages.
- **Does not own:** what the messages drive, such as the block relay, the product frame or the loading screen.

## Design

```mermaid
flowchart LR
  host -- "URL params, checked by validateSandboxParams" --> sandbox
  sandbox -- postToHost --> channel[startSandboxChannel] --> check[origin check] --> handlers[typed handlers]
  host -- "postMessage, parsed on receipt" --> sandbox
```

- **Additive only:** host and sandbox may run different releases after a deploy. Add optional fields or new message
  types. Never rename or retype.
- **Params carry every decision:** the sandbox cannot read the host's settings.
- **No defaults:** an unknown value throws. A missing required param is recoverable, so the host can render again.
- **Schema version:** a new required param bumps `SANDBOX_SCHEMA_VERSION`.
- **Parse on receipt:** any frame can post to a window, so each side drops what does not parse.
- **One host channel:** drops untrusted origins and isolates a throwing handler.

## Public API

### `@dotli/sandbox-wire`

- **Params:** `SANDBOX_SCHEMA_VERSION`, `SANDBOX_CONTRACT_PARAMS`, `validateSandboxParams`, `SandboxContractError` (has
  a `recoverable` flag).
- **Messages:** `parseHostToSandboxMessage`, `postToHost`, `HostToSandboxMessage`, `SandboxToHostMessage`,
  `BitswapResultMessage`.
- **Violation report:** `parseApiViolationMessage`, `ApiViolationMessage`.
- **Recover acceptance:** `parseRecoverAcceptedMessage`, `SandboxRecoverAcceptedMessage`.
- **Load outcome:** `SandboxLoadOutcome`, `isLoadedOutcome`.
- **Channel:** `startSandboxChannel`, `StartedSandboxChannel`, `SandboxChannel` (without `stop`), `SandboxSender`,
  `SandboxMessageType`, `SandboxMessageOf`.

### `@dotli/sandbox-wire/contract-params`

`SANDBOX_SCHEMA_VERSION` and `SANDBOX_CONTRACT_PARAMS` alone. Imports nothing, for Node tooling.
