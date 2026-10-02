// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Provided by the integration's Vite plugin (see configEnvironmentPlugin in
// index.ts). Only resolvable when server.ts is processed by Vite; the runtime
// import in server.ts degrades gracefully when it isn't.
declare module 'virtual:astro-solid-manifest' {
  export function loadManifest(): unknown;
}
