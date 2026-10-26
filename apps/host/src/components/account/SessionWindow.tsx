// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, merge, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { shallowEqual } from '@dotli/shared';
import type { SignInScreen, WindowScreen, WindowView } from '../../state/session-window.js';
import { isMobileDevice } from '../../device.js';
import { loadPhraseScreen, type PhraseScreenModule } from '../../lazy.js';
import { createPhraseFormLoad } from './phrase-form-load.js';
import type { SignInParts } from './sign-in/SignInViews.js';
import { pairingPayload, sameSignInScreen } from './sign-in/same-screen.js';
import { windowParts, type WindowPartsProps, type WindowStep } from './window-parts.js';
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

/** The sign-in window's content, under the page's header. It fills the rest of the page. */
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
      if (screen.view === 'pairing') {
        // A copy, so the screen it builds reads plain values.
        return { view: screen.view, pairing: { ...screen.pairing } };
      }
      if (screen.view === 'continue') {
        return { view: screen.view, offer: screen.offer, phoneFailed: screen.failure === 'phone' };
      }
      if (screen.view === 'phrase') {
        return { view: screen.view, form: phraseForm.form() };
      }
      return { view: screen.view };
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

/** The window page's frame for one screen, laid out for the view it shows. */
export function WindowShell(props: { view: WindowView; parts: SignInParts }): JSX.Element {
  return (
    <main class={s['window']} data-testid="session-window" data-view={props.view}>
      <WindowLayout parts={props.parts} />
    </main>
  );
}

/** The sign-in a screen shows, or null on a sign-out's views, which carry nothing of one. */
function signInOf(screen: WindowScreen): SignInScreen | null {
  return screen.view === 'signing-out' || screen.view === 'signed-out' ? null : screen;
}

function sameStep(a: WindowStep, b: WindowStep): boolean {
  return a.view === 'pairing' && b.view === 'pairing' ? sameSignInScreen(a.pairing, b.pairing) : shallowEqual(a, b);
}

/**
 * Places a screen on the window page: its content and buttons in a card with the note under it, or on a phone over the
 * whole page, with the content in the middle and the buttons and the note at the foot. The buttons stack with the main
 * answer first and the way out last.
 */
function WindowLayout(props: { parts: SignInParts }): JSX.Element {
  const buttons = (): boolean =>
    props.parts.actions !== undefined || props.parts.reveal !== undefined || props.parts.dismiss !== undefined;
  return (
    <>
      <section class={s['card']} data-testid="session-window-card">
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
    </>
  );
}
