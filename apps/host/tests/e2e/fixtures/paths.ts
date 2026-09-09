// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { resolve } from "node:path";

// Shared paths so globalSetup, the worker fixture, and globalTeardown agree
// on where the once-per-run pairing artifacts live. Gitignored.
export const AUTH_DIR = resolve(import.meta.dirname, "..", ".auth");
export const STATE_FILE = resolve(AUTH_DIR, "state.json");
export const SESSION_FILE = resolve(AUTH_DIR, "session.json");
// Persists across runs so local runs reuse one test account instead of
// registering a new lite username (and burning allowance slots) each time.
export const SIGNING_HOST_STATE_DIR = resolve(AUTH_DIR, "signing-host");

export interface PersistedSession {
  pid: number;
  username: string;
  network: string;
  basePath: string;
}
