// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Fakes other packages' tests drive the runtime with. Never imported by shipped code.

export { resetAuthControllerForTests } from '../auth-controller.js';
export { memoryChatRepo, recordingConnection } from '../chat/store.fake.js';
export { answerConnection, createFakePageCore, type FakePageCore } from '../page-core.fake.js';
export { createProductFrame } from '../product-frame.js';
export { type MemorySharedChannel, memorySharedChannel } from '../shared-mode.fake.js';
