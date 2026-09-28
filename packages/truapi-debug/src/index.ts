// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// TrUAPI debug package public API.
//
// This package has no root-level barrel export. Consumers import its
// modules directly via the `./*` subpath map in package.json (for
// example `@dotli/truapi-debug/event-store`,
// `@dotli/truapi-debug/dotli-debug-bus`). The Solid panel UI itself
// lives in `packages/ui/src/components/truapi-debug/` (entry
// `mount.tsx`, exporting `setupTruapiDebugPanel`), which this package
// must not import (dependency cycle).
