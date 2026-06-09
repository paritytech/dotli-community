// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { resolve } from "node:path";

// Shared file paths so globalSetup, the worker fixture, and globalTeardown
// all agree on where the once-per-run pairing artifacts live. The directory
// is gitignored and gets recreated on every `playwright test` invocation.
export const AUTH_DIR = resolve(import.meta.dirname, "..", ".auth");
export const STATE_FILE = resolve(AUTH_DIR, "state.json");
export const SESSION_FILE = resolve(AUTH_DIR, "session.json");

export interface PersistedSession {
  sessionId: string;
  username: string;
  network: string;
  botBase: string;
}
