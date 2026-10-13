// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Fakes other packages' tests drive ui with. Never imported by shipped code.

// A story or test counts the fetches of Popover's lazy surface through its own loader.
export { createPopoverSurface, PopoverSurfaceContext } from '../components/floating/Popover.js';
export { loadPopoverSurface } from './popover-surface.js';
export { settle } from './settle.js';
// Functional tests query and wait on the page through these.
export { appears, byId, byTestId, query } from './queries.dom.js';
