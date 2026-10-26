// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, flush } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { isPhoneViewport } from '@dotli/ui';
import { byTestId } from '@dotli/ui/testing';
import { expectBefore } from '@config/storybook/play';
import type { PairingView } from '../../state/auth-modal.js';
import type { SignInScreen } from '../../state/session-window.js';
import { loadPhraseScreen, type PhraseScreenModule } from '../../lazy.js';
import { expectPhone } from '../../testing/stories/topbar-frame.js';
import { windowPageStory } from '../../testing/stories/window-page.js';
import type { DrawQr } from './qr-code.js';
import { SessionWindow } from './SessionWindow.js';

const DEEPLINK = 'polkadotapp://pair?handshake=test';
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PHONE = { viewport: { value: 'phone', isRotated: false } };
const ALICE = { wallet: 'paired', account: { liteUsername: 'alice.01' } } as const;

/** What the window asks of its page and its flow. */
const onClose = fn<() => void>();
const onCancel = fn<() => void>();
const onContinue = fn<() => void>();
const onUseAnotherAccount = fn<() => void>();
const onGoOnWithoutPhone = fn<() => void>();
const onRetry = fn<() => void>();
const onClosePhrase = fn<() => void>();
const onImportPhrase = fn<(phrase: string) => Promise<void>>(() => Promise.resolve());
/** The QR renderer the window is given, which draws nothing. */
const drawQr = fn<DrawQr>(() => Promise.resolve());
/** The phrase form's loader the window is given, which loads the form's own chunk unless a story says otherwise. */
const loadPhrase = fn<() => Promise<PhraseScreenModule>>(loadPhraseScreen);

const SPINNER: PairingView = { kind: 'spinner' };

/** What a sign-in view carries before anything happened: no page named, no failure and no pairing under way. */
const SIGN_IN_START: Pick<SignInScreen, 'pageHost' | 'failure' | 'pairing'> = {
  pageHost: null,
  failure: null,
  pairing: SPINNER,
};

/** The pairing a story moves step by step, for a window that renders it. */
const [livePairing, setLivePairing] = createSignal<PairingView>(SPINNER);
function pairingMoves(next: PairingView): void {
  setLivePairing(next);
  flush();
}

/** The view a story moves the window to, for a window that renders it. */
type LiveView = 'connecting' | 'phrase';
const [liveView, setLiveView] = createSignal<LiveView>('connecting');
function viewMoves(next: LiveView): void {
  setLiveView(next);
  flush();
}

const meta = {
  title: 'Host/SessionWindow',
  component: SessionWindow,
  ...windowPageStory,
  args: {
    screen: { ...SIGN_IN_START, view: 'connecting' },
    onClose,
    onCancel,
    onContinue,
    onUseAnotherAccount,
    onGoOnWithoutPhone,
    onRetry,
    onClosePhrase,
    onImportPhrase,
    isValidPhrase: phrase => phrase === PHRASE,
    drawQr,
    isMobile: (): boolean => false,
    loadPhraseScreen: loadPhrase,
  },
  beforeEach: () => {
    for (const mock of [
      onClose,
      onCancel,
      onContinue,
      onUseAnotherAccount,
      onGoOnWithoutPhone,
      onRetry,
      onClosePhrase,
    ]) {
      mock.mockClear();
    }
    drawQr.mockClear();
    loadPhrase.mockReset();
    loadPhrase.mockImplementation(loadPhraseScreen);
  },
} satisfies Meta<typeof SessionWindow>;

export default meta;
type Story = StoryObj<typeof meta>;

const windowView = (): HTMLElement => byTestId('session-window');
const card = (): HTMLElement => byTestId('session-window-card');
const status = (): HTMLElement => byTestId('session-window-status');
const buttonNames = (): string[] =>
  [...windowView().querySelectorAll('button')].map(button => button.textContent.trim());
/** The line under the card that says where to get the app. */
const getAppNote = (): HTMLElement => {
  const note = within(document.body).getByRole('link', { name: /^Get it/ }).parentElement;
  if (note === null) {
    throw new Error('The install link has no line around it');
  }
  return note;
};

/** As a user whose window waits for the page that opened it, I see only Connecting in the card and can close it. */
export const Connecting: Story = {
  tags: ['!autodocs'],
  args: { screen: { ...SIGN_IN_START, view: 'connecting' } },
  play: async ({ canvas, userEvent, step }) => {
    await step('Then the card says it is connecting under the page title, with Close alone', async () => {
      await expect(windowView()).toHaveAttribute('data-view', 'connecting');
      await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('Connecting');
      await expect(byTestId('session-window-title')).toHaveTextContent('Connecting');
      await expect(byTestId('session-window-spinner')).toBeVisible();
      await expect(status()).toHaveTextContent('Waiting for the page that opened this window.');
      await expect(buttonNames()).toEqual(['Close']);
      await expect(card()).toContainElement(canvas.getByRole('button', { name: 'Close' }));
    });
    await step('When I press Close', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Close' }));
    });
    await step('Then the window was asked to close once', async () => {
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });
  },
};

/** As a user on a page the window refuses, I am told sign-in is not available for it and can only close. */
export const Refused: Story = {
  tags: ['!autodocs'],
  args: { screen: { ...SIGN_IN_START, view: 'refused' } },
  play: async ({ canvas, userEvent, step }) => {
    await step(
      'Then the window says sign-in is not available for this page, in the idle tone, with Close',
      async () => {
        await expect(windowView()).toHaveAttribute('data-view', 'refused');
        await expect(byTestId('session-window-title')).toHaveTextContent('Sign-in is not available for this page');
        await expect(status()).toHaveAttribute('data-tone', 'idle');
        await expect(status()).toHaveTextContent('This window does not sign in pages at that address.');
        await expect(buttonNames()).toEqual(['Close']);
      },
    );
    await step('When I press Close', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Close' }));
    });
    await step('Then the window was asked to close once', async () => {
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });
  },
};

/** As a user who signed out, I see the window signing out with nothing to press until it is done. */
export const SigningOut: Story = {
  tags: ['!autodocs'],
  args: { screen: { view: 'signing-out' } },
  play: async ({ step }) => {
    await step('Then the window says it is signing out and offers nothing to press', async () => {
      await expect(windowView()).toHaveAttribute('data-view', 'signing-out');
      await expect(byTestId('session-window-title')).toHaveTextContent('Signing out');
      await expect(byTestId('session-window-spinner')).toBeVisible();
      await expect(status()).toHaveTextContent('Signing you out of Polkadot App.');
      await expect(buttonNames()).toEqual([]);
      await expect(onClose).not.toHaveBeenCalled();
    });
  },
};

/** As a user whose sign-out window told Polkadot App, I am told I am signed out everywhere and close the window. */
export const SignedOut: Story = {
  tags: ['!autodocs'],
  args: { screen: { view: 'signed-out' } },
  play: async ({ canvas, userEvent, step }) => {
    await step('Then the window says I am signed out of every app, with Close this window alone', async () => {
      await expect(windowView()).toHaveAttribute('data-view', 'signed-out');
      await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent("You're signed out");
      await expect(status()).toHaveAttribute('data-tone', 'ok');
      await expect(status()).toHaveTextContent(
        'Signed out of every app. Polkadot App is being told to forget this browser.',
      );
      await expect(buttonNames()).toEqual(['Close this window']);
      await expect(byTestId('session-window-close')).toHaveTextContent('Close this window');
    });
    await step('When I press Close this window', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Close this window' }));
    });
    await step('Then the window was asked to close once', async () => {
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });
  },
};

/** As a phone user who signed out, I read that I am signed out and find Close this window after it. */
export const SignedOutPhone: Story = {
  tags: ['!autodocs'],
  globals: PHONE,
  args: { screen: { view: 'signed-out' }, isMobile: () => true },
  play: async ({ canvas, userEvent, step }) => {
    await expectPhone(step);
    await step('Then Close this window follows the title, alone', async () => {
      await expect(buttonNames()).toEqual(['Close this window']);
      await expectBefore(byTestId('session-window-title'), byTestId('session-window-close'));
    });
    await step('When I press Close this window', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Close this window' }));
    });
    await step('Then the window was asked to close once', async () => {
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });
  },
};

/** As a user who signed in from a window no page opened, I am told I am signed in and to return to the app. */
export const DoneNoOpener: Story = {
  tags: ['!autodocs'],
  args: { screen: { ...SIGN_IN_START, view: 'done-no-opener' } },
  play: async ({ step }) => {
    await step("Then the window says I'm signed in and sends me back to the app, with nothing to press", async () => {
      await expect(windowView()).toHaveAttribute('data-view', 'done-no-opener');
      await expect(byTestId('session-window-title')).toHaveTextContent("You're signed in");
      await expect(status()).toHaveAttribute('data-tone', 'ok');
      await expect(status()).toHaveTextContent('Return to the app.');
      await expect(buttonNames()).toEqual([]);
    });
  },
};

/** As a phone user who signed in from a window no page opened, I am told to return to the app, with no button. */
export const DoneNoOpenerPhone: Story = {
  tags: ['!autodocs'],
  globals: PHONE,
  args: { screen: { ...SIGN_IN_START, view: 'done-no-opener' }, isMobile: () => true },
  play: async ({ step }) => {
    await expectPhone(step);
    await step('Then the window says I am signed in and offers nothing to press', async () => {
      await expect(byTestId('session-window-title')).toHaveTextContent("You're signed in");
      await expect(buttonNames()).toEqual([]);
    });
  },
};

/** As a user already signed in, I see my account in the card and continue to the page or use another account. */
export const Continue: Story = {
  tags: ['!autodocs'],
  args: { screen: { ...SIGN_IN_START, view: 'continue', pageHost: 'browse.dot.li', offer: ALICE } },
  play: async ({ canvas, userEvent, step }) => {
    await step('Then the card names my account under Already signed in, with what the page may ask of it', async () => {
      await expect(windowView()).toHaveAttribute('data-view', 'continue');
      await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('alice.01');
      await expect(byTestId('session-window-title')).toHaveTextContent('alice.01');
      await expect(byTestId('session-window-continue')).toHaveTextContent('Already signed in');
      await expect(byTestId('session-window-note')).toHaveTextContent(
        'browse.dot.li can ask this account to sign. Polkadot App asks you before each one.',
      );
      await expect(canvas.queryByTestId('session-window-local')).toBeNull();
    });
    await step('Then Continue to the page leads and Use another account follows, in the card', async () => {
      await expect(buttonNames()).toEqual(['Continue to browse.dot.li', 'Use another account']);
      await expect(card()).toContainElement(byTestId('session-window-another'));
    });
    await step('When I press Continue to the page', async () => {
      await userEvent.click(byTestId('session-window-continue-button'));
    });
    await step('Then the window was asked to continue once', async () => {
      await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
      await expect(onUseAnotherAccount).not.toHaveBeenCalled();
    });
    await step('When I press Use another account', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Use another account' }));
    });
    await step('Then the window was asked to use another account once', async () => {
      await waitFor(() => expect(onUseAnotherAccount).toHaveBeenCalledTimes(1));
    });
  },
};

/** As a phone user already signed in, I read my account first and find the two choices after it. */
export const ContinuePhone: Story = {
  tags: ['!autodocs'],
  globals: PHONE,
  args: {
    screen: { ...SIGN_IN_START, view: 'continue', pageHost: 'browse.dot.li', offer: ALICE },
    isMobile: () => true,
  },
  play: async ({ step }) => {
    await expectPhone(step);
    await step('Then the account and its note come before Continue and Use another account', async () => {
      await expect(buttonNames()).toEqual(['Continue to browse.dot.li', 'Use another account']);
      await expectBefore(byTestId('session-window-note'), byTestId('session-window-continue-button'));
    });
  },
};

/**
 * As a user in the sign-in window with a wallet that has no identity, I see the generic label, marked as a local
 * account.
 */
export const ContinueGenericWallet: Story = {
  tags: ['!autodocs'],
  args: {
    screen: {
      ...SIGN_IN_START,
      view: 'continue',
      pageHost: 'browse.dot.li',
      offer: { wallet: 'local', account: null },
    },
  },
  play: async ({ step }) => {
    await step('Then the window shows the generic wallet label and the local badge', async () => {
      await expect(byTestId('session-window-title')).toHaveTextContent('Recovery phrase wallet');
      await expect(byTestId('session-window-local')).toHaveTextContent('Local account');
    });
  },
};

/** As a user whose sign-out of the stored account failed, I am told so and can try Use another account again. */
export const ContinueSignOutFailed: Story = {
  tags: ['!autodocs'],
  args: {
    screen: { ...SIGN_IN_START, view: 'continue', pageHost: 'browse.dot.li', offer: ALICE, failure: 'sign-out' },
  },
  play: async ({ canvas, userEvent, step }) => {
    await step('Then the window says the account could not be signed out, with both choices still there', async () => {
      await expect(canvas.getByRole('alert')).toHaveTextContent('This account could not be signed out. Try again.');
      await expect(byTestId('session-window-failure')).toBe(canvas.getByRole('alert'));
      await expect(buttonNames()).toEqual(['Continue to browse.dot.li', 'Use another account']);
    });
    await step('When I press Use another account again', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Use another account' }));
    });
    await step('Then the window was asked once more', async () => {
      await waitFor(() => expect(onUseAnotherAccount).toHaveBeenCalledTimes(1));
    });
  },
};

/**
 * As a user whose sign-out of the stored account Polkadot App could not be told of, I am told so and can try again or
 * go on to another account.
 */
export const ContinuePhoneNotTold: Story = {
  tags: ['!autodocs'],
  args: { screen: { ...SIGN_IN_START, view: 'continue', pageHost: 'browse.dot.li', offer: ALICE, failure: 'phone' } },
  play: async ({ canvas, userEvent, step }) => {
    await step('Then the window says the phone still lists this browser, with no account offered', async () => {
      await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('Not signed out of Polkadot App');
      await expect(byTestId('session-window-phone-failed')).toHaveAttribute('data-tone', 'warn');
      await expect(canvas.getByRole('alert')).toHaveTextContent(
        'Polkadot App could not be told. It still lists this browser.',
      );
      await expect(byTestId('session-window-failure')).toBe(canvas.getByRole('alert'));
      await expect(canvas.queryByText('alice.01')).toBeNull();
      await expect(canvas.queryByTestId('session-window-avatar')).toBeNull();
      await expect(buttonNames()).toEqual(['Try again', 'Use another account anyway']);
    });
    await step('When I press Try again', async () => {
      await userEvent.click(byTestId('session-window-another-retry'));
    });
    await step('Then the window was asked to sign out once more', async () => {
      await waitFor(() => expect(onUseAnotherAccount).toHaveBeenCalledTimes(1));
      await expect(onGoOnWithoutPhone).not.toHaveBeenCalled();
    });
    await step('When I press Use another account anyway', async () => {
      await userEvent.click(byTestId('session-window-go-on'));
    });
    await step('Then the window was asked to go on without the phone once', async () => {
      await waitFor(() => expect(onGoOnWithoutPhone).toHaveBeenCalledTimes(1));
    });
  },
};

/**
 * As a desktop user with no sign-in, I see the code to scan in the card for the page I sign in to, and where to get
 * the app under it, with no other way in.
 */
export const Pairing: Story = {
  tags: ['!autodocs'],
  args: {
    screen: {
      ...SIGN_IN_START,
      view: 'pairing',
      pageHost: 'browse.dot.li',
      pairing: { kind: 'pairing', payload: DEEPLINK },
    },
  },
  play: async ({ canvas, step }) => {
    await step('Then the card shows the code under a page title that names the page', async () => {
      await expect(windowView()).toHaveAttribute('data-view', 'pairing');
      await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('Sign in with Polkadot App');
      await expect(byTestId('auth-modal-hint')).toHaveTextContent(
        'Scan the code to continue to browse.dot.li. One sign-in works across every app.',
      );
      const code = await canvas.findByRole('img', { name: 'Sign-in QR code' });
      await expect(code).toBeVisible();
      await expect(card()).toContainElement(code);
      await expect(canvas.getAllByRole('listitem').map(item => item.textContent)).toEqual([
        '1Scan QR code with your phone',
        '2Approve',
      ]);
    });
    await step('Then where to get the app sits under the card, and there is nothing to press', async () => {
      await expect(getAppNote()).toHaveTextContent('No Polkadot App yet? Get it for iPhone or Android');
      await expect(card()).not.toContainElement(getAppNote());
      await expectBefore(card(), getAppNote());
      await expect(buttonNames()).toEqual([]);
      await expect(canvas.queryByText('Use a recovery phrase')).toBeNull();
    });
  },
};

/** As a phone user with no sign-in, I see Open Polkadot App and Scan from another phone, with where to get the app. */
export const PairingPhone: Story = {
  tags: ['!autodocs'],
  globals: PHONE,
  args: {
    screen: {
      ...SIGN_IN_START,
      view: 'pairing',
      pageHost: 'browse.dot.li',
      pairing: { kind: 'pairing', payload: DEEPLINK },
    },
    isMobile: () => true,
  },
  play: async ({ canvas, step }) => {
    await expectPhone(step);
    await step(
      'Then the heading leads, then Open Polkadot App, Scan from another phone and the install line',
      async () => {
        const openApp = canvas.getByRole('link', { name: 'Open Polkadot App' });
        await expect(openApp).toHaveAttribute('href', DEEPLINK);
        await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('Sign in with Polkadot App');
        await expect(byTestId('auth-modal-hint')).toHaveTextContent(
          'Approve in the app to continue to browse.dot.li. One sign-in works across every app.',
        );
        await expectBefore(canvas.getByRole('heading', { level: 1 }), openApp);
        await expectBefore(openApp, canvas.getByRole('button', { name: 'Scan from another phone' }));
        await expectBefore(canvas.getByRole('button', { name: 'Scan from another phone' }), getAppNote());
        await expect(getAppNote()).toHaveTextContent('No Polkadot App yet? Get it');
        await expect(buttonNames()).toEqual(['Scan from another phone']);
        await expect(canvas.queryByText('Use a recovery phrase')).toBeNull();
      },
    );
  },
};

/** As a phone user who presses Scan from another phone before the code exists, I see the code once it arrives. */
export const PairingPhoneScanBeforeCode: Story = {
  tags: ['!autodocs'],
  globals: PHONE,
  args: { isMobile: () => true },
  beforeEach: () => {
    pairingMoves(SPINNER);
  },
  render: args => (
    <SessionWindow
      {...args}
      screen={{ ...SIGN_IN_START, view: 'pairing', pageHost: 'browse.dot.li', pairing: livePairing() }}
    />
  ),
  play: async ({ canvas, userEvent, step }) => {
    await expectPhone(step);
    await step('When I press Scan from another phone while the code is being made', async () => {
      await expect(byTestId('auth-modal-hint')).toHaveTextContent('Getting a sign-in code ready.');
      await userEvent.click(canvas.getByRole('button', { name: 'Scan from another phone' }));
    });
    await step('Then the button is gone', async () => {
      await waitFor(() => expect(canvas.queryByRole('button', { name: 'Scan from another phone' })).toBeNull());
    });
    await step('When the code arrives', () => {
      pairingMoves({ kind: 'pairing', payload: DEEPLINK });
    });
    await step('Then the code shows, linked to the deeplink, with no button to show it again', async () => {
      const code = await canvas.findByRole('img', { name: 'Sign-in QR code' });
      await expect(byTestId('auth-modal-qr-link')).toContainElement(code);
      await expect(byTestId('auth-modal-qr-link')).toHaveAttribute('href', DEEPLINK);
      await expect(byTestId('auth-modal-hint')).toHaveTextContent(
        'Scan the code to continue to browse.dot.li. One sign-in works across every app.',
      );
      await expect(buttonNames()).toEqual([]);
      await expect(drawQr).toHaveBeenCalledTimes(1);
    });
  },
};

/** As a desktop user narrowing the window page to a phone and back, I keep the one code, drawn once at 300 px. */
export const PairingQrOneSize: Story = {
  tags: ['!autodocs'],
  args: {
    screen: {
      ...SIGN_IN_START,
      view: 'pairing',
      pageHost: 'browse.dot.li',
      pairing: { kind: 'pairing', payload: DEEPLINK },
    },
  },
  play: async ({ canvas, step }) => {
    const { page } = await import('vitest/browser');
    const wide = { width: window.innerWidth, height: window.innerHeight };
    const drawnWidths = (): number[] => drawQr.mock.calls.map(([, , options]) => options.width);
    try {
      await step('Given the code drawn at 300 px on a wide screen', async () => {
        await canvas.findByRole('img', { name: 'Sign-in QR code' });
        await expect(drawnWidths()).toEqual([300]);
      });
      await step('When the window narrows to a phone', async () => {
        await page.viewport(390, 844);
        await waitFor(() => expect(isPhoneViewport()).toBe(true));
      });
      await step('Then the same code stays, drawn once', async () => {
        await expect(canvas.getByRole('img', { name: 'Sign-in QR code' })).toBeInTheDocument();
        await expect(drawnWidths()).toEqual([300]);
      });
      await step('When it widens again', async () => {
        await page.viewport(wide.width, wide.height);
        await waitFor(() => expect(isPhoneViewport()).toBe(false));
      });
      await step('Then the code is still the one drawn once', async () => {
        await expect(drawnWidths()).toEqual([300]);
      });
    } finally {
      await page.viewport(wide.width, wide.height);
    }
  },
};

/** As a user who scanned the code, I am asked to approve on my phone, told the window closes, and can cancel. */
export const Approving: Story = {
  tags: ['!autodocs'],
  args: {
    screen: { ...SIGN_IN_START, view: 'pairing', pageHost: 'browse.dot.li', pairing: { kind: 'authenticating' } },
  },
  play: async ({ canvas, userEvent, step }) => {
    await step('Then the window asks me to approve in the app and says it closes when I am done', async () => {
      await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('Approve in Polkadot App');
      await expect(card()).toHaveTextContent(
        "Check your phone and approve the sign-in. This window closes when you're done.",
      );
      await expect(canvas.getByRole('status')).toHaveTextContent('Signing in…');
      await expect(buttonNames()).toEqual(['Cancel']);
    });
    await step('When I press Cancel', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
    });
    await step('Then the round was cancelled once, not the window closed outright', async () => {
      await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
      await expect(onClose).not.toHaveBeenCalled();
    });
  },
};

/** As a user whose pairing was declined, I see why and can pair again. */
export const PairingFailed: Story = {
  tags: ['!autodocs'],
  args: {
    screen: {
      ...SIGN_IN_START,
      view: 'pairing',
      pageHost: 'browse.dot.li',
      pairing: {
        kind: 'error',
        message: 'Rejected',
        retry: true,
        pending: false,
        title: 'Sign-in was declined',
        subtitle: 'The request was declined in Polkadot App. Start again and approve it on your phone.',
        detail: 'Rejected',
      },
    },
  },
  play: async ({ canvas, userEvent, step }) => {
    await step('Then the window shows the failure as the page title, with Try again alone', async () => {
      await expect(byTestId('auth-modal-failure')).toHaveTextContent('Sign-in was declined');
      await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('Sign-in was declined');
      await expect(buttonNames()).toEqual(['Try again']);
    });
    await step('When I press Try again', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Try again' }));
    });
    await step('Then the window was asked to pair again once', async () => {
      await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
    });
  },
};

/** As a user whose window failed a step of its own, I see that it failed and can try again or give up. */
export const StepFailed: Story = {
  tags: ['!autodocs'],
  args: { screen: { ...SIGN_IN_START, view: 'failed', pageHost: 'browse.dot.li' } },
  play: async ({ canvas, userEvent, step }) => {
    await step('Then the window shows the failure in its tone with Try again and Cancel', async () => {
      await expect(windowView()).toHaveAttribute('data-view', 'failed');
      await expect(byTestId('auth-modal-failure')).toHaveAttribute('data-tone', 'err');
      await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('Something went wrong');
      await expect(byTestId('auth-modal-failure')).toHaveTextContent(
        'This window could not go on with the sign-in. Try again.',
      );
      await expect(canvas.queryByTestId('session-window-spinner')).toBeNull();
      await expect(buttonNames()).toEqual(['Try again', 'Cancel']);
    });
    await step('When I press Try again', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Try again' }));
    });
    await step('Then the window was asked to try again once', async () => {
      await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
    });
    await step('When I give up', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
    });
    await step('Then the round was cancelled', async () => {
      await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    });
  },
};

/** As a debug panel user, I open no phrase view and load no phrase form. */
export const NoPhraseViewNoForm: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('Then the window is connecting and the phrase form was never loaded', async () => {
      await expect(windowView()).toHaveAttribute('data-view', 'connecting');
      await expect(byTestId('session-window-spinner')).toBeVisible();
      await expect(loadPhrase).not.toHaveBeenCalled();
    });
  },
};

/** As a debug panel user, I see the spinner until the phrase form has loaded. */
export const PhraseFormLoads: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    viewMoves('connecting');
  },
  render: args => <SessionWindow {...args} screen={{ ...SIGN_IN_START, view: liveView() }} />,
  play: async ({ canvas, step }) => {
    const form = Promise.withResolvers<PhraseScreenModule>();
    await step('Given a phrase form that is still loading', async () => {
      loadPhrase.mockImplementation(() => form.promise);
      await expect(loadPhrase).not.toHaveBeenCalled();
    });
    await step('When the window moves to the phrase view', () => {
      viewMoves('phrase');
    });
    await step('Then the spinner holds its place and the form was asked for once', async () => {
      await expect(windowView()).toHaveAttribute('data-view', 'phrase');
      await expect(byTestId('session-window-spinner')).toBeVisible();
      await expect(canvas.queryByTestId('session-window-phrase')).toBeNull();
      await expect(loadPhrase).toHaveBeenCalledTimes(1);
    });
    await step('When the form has loaded', async () => {
      form.resolve(await loadPhraseScreen());
    });
    await step('Then the form shows, loaded once', async () => {
      await expect(await canvas.findByTestId('session-window-phrase')).toBeVisible();
      await expect(canvas.queryByTestId('session-window-spinner')).toBeNull();
      await expect(loadPhrase).toHaveBeenCalledTimes(1);
    });
  },
};

/** As a debug panel user, I leave and come back to the phrase view while the form loads and it loads once. */
export const PhraseFormOneLoadAcrossShows: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    viewMoves('connecting');
  },
  render: args => <SessionWindow {...args} screen={{ ...SIGN_IN_START, view: liveView() }} />,
  play: async ({ canvas, step }) => {
    const form = Promise.withResolvers<PhraseScreenModule>();
    await step('Given a phrase form that is still loading', () => {
      loadPhrase.mockImplementation(() => form.promise);
    });
    await step('When the window moves to the phrase view, away and back to it', async () => {
      viewMoves('phrase');
      await expect(loadPhrase).toHaveBeenCalledTimes(1);
      viewMoves('connecting');
      await expect(windowView()).toHaveAttribute('data-view', 'connecting');
      viewMoves('phrase');
      await expect(windowView()).toHaveAttribute('data-view', 'phrase');
    });
    await step('When the load fails', () => {
      form.reject(new Error('chunk'));
    });
    await step('Then the failed view shows and the form was loaded once', async () => {
      await expect(await canvas.findByTestId('auth-modal-failure')).toHaveAttribute('data-tone', 'err');
      await expect(loadPhrase).toHaveBeenCalledTimes(1);
    });
  },
};

/** As a debug panel user, I retry a phrase form that failed to load and see it. */
export const PhraseFormRetry: Story = {
  tags: ['!autodocs'],
  args: { screen: { ...SIGN_IN_START, view: 'phrase' } },
  beforeEach: () => {
    loadPhrase.mockRejectedValueOnce(new Error('chunk'));
  },
  play: async ({ canvas, userEvent, step }) => {
    await step('Then the window says something went wrong and offers Try again', async () => {
      await expect(await canvas.findByTestId('auth-modal-failure')).toHaveAttribute('data-tone', 'err');
      await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('Something went wrong');
      await expect(buttonNames()).toEqual(['Try again', 'Cancel']);
      await expect(loadPhrase).toHaveBeenCalledTimes(1);
    });
    await step('When I press Try again', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Try again' }));
    });
    await step('Then the form shows, loaded again, and the flow was not asked to try again', async () => {
      await expect(await canvas.findByTestId('session-window-phrase')).toBeVisible();
      await expect(loadPhrase).toHaveBeenCalledTimes(2);
      await expect(onRetry).not.toHaveBeenCalled();
    });
  },
};

/** As a developer with a recovery phrase, I see the form in the window's card and Back leaves the phrase view. */
export const Phrase: Story = {
  tags: ['!autodocs'],
  args: { screen: { ...SIGN_IN_START, view: 'phrase', pageHost: 'browse.dot.li' } },
  play: async ({ canvas, userEvent, step }) => {
    await step('Then the card shows the phrase form with its warning', async () => {
      await canvas.findByTestId('session-window-phrase');
      await expect(windowView()).toHaveAttribute('data-view', 'phrase');
      await expect(byTestId('session-window-phrase-title')).toHaveTextContent('Sign in with a recovery phrase');
      await expect(byTestId('session-window-phrase-warning')).toHaveTextContent('This is not secure.');
      await expect(card()).toContainElement(byTestId('session-window-phrase'));
    });
    await step('When I press Back', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Back' }));
    });
    await step('Then the window was asked to leave the phrase view once', async () => {
      await waitFor(() => expect(onClosePhrase).toHaveBeenCalledTimes(1));
    });
  },
};
