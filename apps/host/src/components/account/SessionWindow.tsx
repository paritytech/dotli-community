// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, merge, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { isShallowEqual } from '@dotli/shared';
import type { SignInScreen, WindowScreen } from '../../state/sessionWindowState.js';
import { isMobileDevice } from '../../isMobileDevice.js';
import { loadPhraseScreen, type PhraseScreenModule } from '../../lazy.js';
import { createPhraseFormLoad } from './phraseFormLoad.js';
import type { SignInParts } from './signIn/SignInViews.js';
import { pairingPayload, sameSignInScreen } from './signIn/sameScreen.js';
import { windowParts, type WindowPartsProps, type WindowStep } from './windowParts.js';
import s from './SessionWindow.module.css';

export type SessionWindowProps = Omit<
  WindowPartsProps,
  'host' | 'failure' | 'payload' | 'mobile' | 'onReloadPhrase'
> & {
  /** What the window shows, with each view's own fields. */
  screen: WindowScreen;
  /** Without one, the browser's own answer. */
  isMobile?: (() => boolean) | undefined;
  /** Read once. Without one, the phrase form's own chunk. */
  loadPhraseScreen?: (() => Promise<PhraseScreenModule>) | undefined;
};

/** The session window's content, under the page's header. It fills the rest of the page. */
export function SessionWindow(props: SessionWindowProps): JSX.Element {
  // The build-time render has no device, so it takes the desktop layout.
  const mobile = createMemo(() => (props.isMobile ?? isMobileDevice)(), { ssrSource: 'client', loadingValue: false });

  // Read apart from the step, which keeps the pairing screen it built while the code to scan comes and changes.
  const payload = createMemo(() => {
    const shown = signInOf(props.screen);
    return shown === null ? null : pairingPayload(shown.pairing);
  });

  // The phrase form is debug only, so its chunk loads the first time the phrase view is on show.
  const phraseForm = createPhraseFormLoad(
    untrack(() => props.loadPhraseScreen) ?? loadPhraseScreen,
    () => props.screen.view === 'phrase',
  );

  const step = createMemo<WindowStep>(
    () => {
      const screen = props.screen;
      switch (screen.view) {
        case 'pairing':
          // A copy, so the screen it builds reads plain values.
          return { view: screen.view, pairing: { ...screen.pairing } };
        case 'continue':
          return { view: screen.view, offer: screen.offer, phoneFailed: screen.failure === 'phone' };
        case 'phrase':
          return { view: screen.view, form: phraseForm.form() };
        case 'consent':
          return { view: screen.view, origin: screen.origin, group: screen.group };
        case 'site-signing':
          return { view: screen.view, origin: screen.origin, route: screen.route };
        case 'site-review':
          return { view: screen.view, origin: screen.origin, call: screen.call, account: screen.account };
        case 'site-sharing':
        case 'site-approving':
          return { view: screen.view, origin: screen.origin };
        case 'site-failed':
          return { view: screen.view, origin: screen.origin, route: screen.route, retry: screen.retry };
        case 'sites':
          return { view: screen.view, sites: screen.sites };
        case 'connecting':
        case 'failed':
        case 'refused':
        case 'done-no-opener':
        case 'signing-out':
        case 'signed-out':
        case 'site-not-allowed':
        case 'site-unsupported':
        case 'sites-loading':
        case 'sites-failed':
          return { view: screen.view };
      }
    },
    { equals: sameStep },
  );

  const partsProps: WindowPartsProps = merge(props, {
    get host() {
      return signInOf(props.screen)?.pageHost ?? null;
    },
    get failure() {
      return signInOf(props.screen)?.failure ?? null;
    },
    get payload() {
      return payload();
    },
    get mobile() {
      return mobile();
    },
    onReloadPhrase: phraseForm.reload,
  });

  // A new step builds its screen anew, and the screen built for the last one is disposed with its drawing. A screen
  // reads the device once, so a new reading builds it anew too.
  const parts = createMemo(() => {
    const current = step();
    mobile();
    return untrack(() => windowParts(current, partsProps));
  });

  return <WindowShell view={props.screen.view} parts={parts()} />;
}

/**
 * The window page's frame for one screen, laid out for the view it shows: its content and buttons in a card with the
 * note under it, or on a phone over the whole page, with the content in the middle and the buttons and the note at the
 * foot. The buttons stack with the main answer first and the way out last.
 */
export function WindowShell(props: { view: WindowScreen['view']; parts: SignInParts }): JSX.Element {
  let card: HTMLElement | undefined;
  const buttons = (): boolean =>
    props.parts.actions !== undefined || props.parts.reveal !== undefined || props.parts.dismiss !== undefined;
  // A new screen may replace the control that had focus, so the card takes it rather than leave it on the page.
  createEffect(
    () => props.parts,
    (_, previous) => {
      if (previous !== undefined && document.activeElement === document.body) {
        card?.focus();
      }
    },
  );
  return (
    <main class={s['window']} data-testid="session-window" data-view={props.view}>
      <section
        ref={el => {
          card = el;
        }}
        class={s['card']}
        tabindex="-1"
        data-testid="session-window-card"
      >
        <div class={s['content']}>{props.parts.content}</div>
        <Show when={buttons()}>
          <div class={s['actions']}>
            {props.parts.actions}
            {props.parts.reveal}
            {props.parts.dismiss}
          </div>
        </Show>
      </section>
      {props.parts.note}
    </main>
  );
}

/** dot.li's own sign-in a screen shows, or null on a sign-out's or a site's views, which carry nothing of one. */
function signInOf(screen: WindowScreen): SignInScreen | null {
  return 'pageHost' in screen ? screen : null;
}

function sameStep(a: WindowStep, b: WindowStep): boolean {
  return a.view === 'pairing' && b.view === 'pairing' ? sameSignInScreen(a.pairing, b.pairing) : isShallowEqual(a, b);
}
