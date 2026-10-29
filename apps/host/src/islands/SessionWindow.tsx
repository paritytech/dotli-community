// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { pageScreen, RootBoundary, useStore } from '@dotli/ui';
import { showBrokenPage } from '../showBrokenPage.js';
import { SessionWindow as Content } from '../components/account/SessionWindow.js';
import { sessionWindowState } from '../state/sessionWindowState.js';

/**
 * The session window's content, bound to the view its entry writes. The page is nothing but this, so a failure breaks
 * the whole page, and a full-page screen takes it over.
 */
export function SessionWindow(): JSX.Element {
  const shown = useStore(pageScreen.store, content => content === 'page');
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
  const screen = useStore(sessionWindowState.store);
  return (
    <Content
      screen={screen()}
      onClose={() => {
        sessionWindowState.getCloseIntent()();
      }}
      onCancel={() => {
        sessionWindowState.getWindowIntents().cancel();
      }}
      onContinue={() => {
        void sessionWindowState.getWindowIntents().continueWithStored();
      }}
      onUseAnotherAccount={() => {
        void sessionWindowState.getWindowIntents().useAnotherAccount();
      }}
      onGoOnWithoutPhone={() => {
        void sessionWindowState.getWindowIntents().goOnWithoutPhone();
      }}
      onRetry={() => {
        void sessionWindowState.getWindowIntents().retry();
      }}
      onClosePhrase={() => {
        void sessionWindowState.getWindowIntents().closePhrase();
      }}
      onImportPhrase={phrase => sessionWindowState.getWindowIntents().importPhrase(phrase)}
      isValidPhrase={phrase => sessionWindowState.getWindowIntents().isValidPhrase(phrase)}
      onConsent={() => {
        void sessionWindowState.getSiteIntents().consent();
      }}
      onDecline={() => {
        sessionWindowState.getSiteIntents().decline();
      }}
      onSiteConfirm={() => {
        sessionWindowState.getSiteIntents().confirm();
      }}
      onSiteRetry={() => {
        void sessionWindowState.getSiteIntents().retry();
      }}
      onSiteCancel={() => {
        sessionWindowState.getSiteIntents().cancel();
      }}
      onRevoke={token => {
        void sessionWindowState.getSiteListIntents().revoke(token);
      }}
      onSiteListRetry={() => {
        void sessionWindowState.getSiteListIntents().retry();
      }}
    />
  );
}
