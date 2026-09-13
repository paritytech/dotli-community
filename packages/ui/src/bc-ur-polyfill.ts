// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Buffer } from "buffer";

// @ngraveio/bc-ur is CommonJS and refers to these Node globals while loading.
Reflect.set(globalThis, "Buffer", Buffer);
if (!("process" in globalThis)) {
  Reflect.set(globalThis, "process", { env: {} });
}
