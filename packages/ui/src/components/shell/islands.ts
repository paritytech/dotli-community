// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shell's islands, which the host's Astro page places (apps/host/src/
// pages/index.astro and components/Shell.astro). The ones whose first render
// only matches the build-time render in the browser render there only
// (`client:only`: the account button, the auth modal, the URL bar); the rest
// are server-rendered with the page and hydrated.

export { AuthButton } from './AuthButton.js';
export { AuthModal } from './AuthModal.js';
export { ChatDock } from '../chat/ChatDock.js';
export { LoadingScreen } from './LoadingScreen.js';
export { Topbar } from './Topbar.js';
export { TopbarReveal } from './TopbarReveal.js';
export { UrlPill } from './UrlPill.js';
