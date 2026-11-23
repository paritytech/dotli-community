# `@dotli/quickjs-runtime`

## Overview

Runs an ES module in a QuickJS VM, on the release asyncify build of QuickJS. The module reaches its host through
`__HOST_API_PORT__`, a MessagePort-like object that carries bytes. The host holds the other end, the wire. The runtime
knows nothing of the host, products or TrUAPI. What the bytes mean is the caller's.

## Responsibilities

- **Owns:**
  - one VM and its own WebAssembly module, and freeing them
  - the host API port in the VM and the wire to it
  - the globals the VM's code reads: `__HOST_WEBVIEW_MARK__`, and `top` and `window` as the global object
  - loading the entrypoint and its imports from a map of files
- **Does not own:** where the files come from, or the protocol on the wire.

## Public API

| Export            | What it is                                      |
| ----------------- | ----------------------------------------------- |
| `createQuickJsVm` | Builds one VM, ready to run its entrypoint      |
| `QuickJsVm`       | What it builds                                  |
| `QuickJsVmParams` | Its options                                     |
| `ModuleFiles`     | The files: bytes by path                        |
| `ByteWire`        | The host's end of the port, which carries bytes |

`createQuickJsVm` options:

| Option       | Meaning                                        |
| ------------ | ---------------------------------------------- |
| `files`      | The module files, by path                      |
| `entrypoint` | The path of the ES module that `run` evaluates |
| `onError`    | Hears what goes wrong in the VM outside a run  |

A `QuickJsVm` has:

- `wire`: `postMessage(bytes)` delivers a frame to the module's listeners, and `subscribe(listener)` hears each frame
  the module posts.
- `run()`: evaluates the entrypoint. It resolves once the module and its top-level await finish, and rejects with the
  VM's message when the module throws or an import is missing. A repeated call returns the first run.
- `dispose()`: closes the port and frees the VM. Safe to call again.

## Design

```mermaid
flowchart LR
  host[caller] -- "wire.postMessage(bytes)" --> port["__HOST_API_PORT__"]
  port -- "message event" --> module[ES module in the VM]
  module -- "port.postMessage(bytes)" --> port
  port -- "wire.subscribe" --> host
  files[files by path] -- "module loader" --> module
```

- **One WebAssembly module per VM:** freeing a VM can abort its module when the VM's code still holds objects. The abort
  then ends that VM alone, and `dispose` reports it to `onError` rather than throwing.
- **Bytes are copied:** a frame is copied into the VM and out of it, so neither side can change what the other holds.
- **Jobs run after each frame:** the promise jobs the listeners queue run before `postMessage` returns.
- **Listeners:** the port takes `onmessage` and up to 32 `message` listeners. Adding one listener twice adds it once,
  told apart by the VM's own `===`. A listener past the cap is dropped and reported.
- **Imports:** a relative specifier resolves against the importing module's directory. Any other specifier is a path in
  the files as written. The loader answers at once, so the VM never suspends while it loads a module.
- **Browser marks:** `top` and `window` are the global object and cannot be replaced or deleted.
