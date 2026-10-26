// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { pageContentStore, RootBoundary, useStore } from '@dotli/ui';
import { showBrokenPage } from '../broken-page.js';
import { SessionWindow as Content } from '../components/account/SessionWindow.js';
import {
  closeIntent,
  sessionWindowStore,
  siteIntents,
  siteListIntents,
  windowIntents,
} from '../state/session-window.js';

/**
 * The session window's content, bound to the view its entry writes. The page is nothing but this, so a failure breaks
 * the whole page, and a full-page screen takes it over.
 */
export function SessionWindow(): JSX.Element {
  const shown = useStore(pageContentStore, content => content === 'page');
  return (
    <Show when={shown()}>
      <RootBoundary
        root="island:SessionWindow"
        onBroken={() => {
          showBrokenPage();
        }}
      >
        <BoundContent />
      </RootBoundary>
    </Show>
  );
}

// Inside the boundary, so a store read that throws also breaks to the page's error screen.
function BoundContent(): JSX.Element {
  const screen = useStore(sessionWindowStore);
  return (
    <Content
      screen={screen()}
      onClose={() => {
        closeIntent()();
      }}
      onCancel={() => {
        windowIntents().cancel();
      }}
      onContinue={() => {
        void windowIntents().continueWithStored();
      }}
      onUseAnotherAccount={() => {
        void windowIntents().useAnotherAccount();
      }}
      onGoOnWithoutPhone={() => {
        void windowIntents().goOnWithoutPhone();
      }}
      onRetry={() => {
        void windowIntents().retry();
      }}
      onClosePhrase={() => {
        void windowIntents().closePhrase();
      }}
      onImportPhrase={phrase => windowIntents().importPhrase(phrase)}
      isValidPhrase={phrase => windowIntents().isValidPhrase(phrase)}
      onConsent={() => {
        void siteIntents().consent();
      }}
      onDecline={() => {
        siteIntents().decline();
      }}
      onSiteConfirm={() => {
        siteIntents().confirm();
      }}
      onSiteRetry={() => {
        void siteIntents().retry();
      }}
      onSiteCancel={() => {
        siteIntents().cancel();
      }}
      onRevoke={token => {
        void siteListIntents().revoke(token);
      }}
      onSiteListRetry={() => {
        void siteListIntents().retry();
      }}
    />
  );
}
