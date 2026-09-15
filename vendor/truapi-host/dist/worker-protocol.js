// Wire format between the main thread (`createWebWorkerPairingHostRuntime`) and the
// Web Worker that hosts the truapi-server WASM runtime.
//
//   Main window / host JS
//   ┌─────────────────────────────────────────────────────────────────┐
//   │ createWebWorkerPairingHostRuntime                               │
//   │ host callbacks: storage, DOM prompts, chain provider, logging   │
//   └───────────────┬─────────────────────────────────────────────────┘
//                   │ MainToWorker: init, createCore, frame,
//                   │               callbackResponse, subscriptionItem,
//                   │               chainResponse
//                   v
//   Dedicated Worker
//   ┌─────────────────────────────────────────────────────────────────┐
//   │ shared truapi-server WASM PairingHostRuntime + product runtimes │
//   │ generated raw-callback proxy                                    │
//   └───────────────┬─────────────────────────────────────────────────┘
//                   │ WorkerToMain: coreReady, frame, callbackRequest,
//                   │               subscriptionStart, chainConnect
//                   v
//   Main window dispatches those requests to the actual host callbacks.
//
// Frames (`kind: 'frame'`) carry SCALE-encoded `ProtocolMessage` bytes
// untouched in either direction. Everything else is a control message
// for callback dispatch, subscription bookkeeping, or chain connections.
//
// Frame bytes cross the boundary by structured clone, deliberately not as
// transferables: the sender keeps using its buffer (the worker side posts
// views into WASM memory) and frames are small, so the copy is the simpler
// safe choice.
export {};
