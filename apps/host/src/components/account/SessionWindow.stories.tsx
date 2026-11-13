// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, flush } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { isPhoneViewport } from '@dotli/ui';
import { byTestId } from '@dotli/ui/testing';
import { expectBefore } from '@config/storybook/play';
import { must } from '@dotli/shared/testing';
import type { PairingView } from '../../state/authModalState.js';
import type { SiteListScreen } from '../../runtime/siteSignIn/createSiteList.js';
import type { SignInScreen } from '../../state/sessionWindowState.js';
import { loadPhraseScreen, type PhraseScreenModule } from '../../lazy.js';
import { expectPhone } from '../../testing/stories/topbarFrame.js';
import { windowPageStory } from '../../testing/stories/windowPage.js';
import type { DrawQr } from './qrCode.js';
import { SessionWindow } from './SessionWindow.js';

const DEEPLINK = 'polkadotapp://pair?handshake=test';
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PHONE = { viewport: { value: 'phone', isRotated: false } };
const ALICE = { wallet: 'paired', account: { liteUsername: 'alice.01' } } as const;
/** A site's full origin, port included, as the window names it. */
const SITE_ORIGIN = 'https://site.example:8443';

/** What the window asks of its page and its flow. */
const onClose = fn<() => void>();
const onCancel = fn<() => void>();
const onContinue = fn<() => void>();
const onUseAnotherAccount = fn<() => void>();
const onGoOnWithoutPhone = fn<() => void>();
const onRetry = fn<() => void>();
const onClosePhrase = fn<() => void>();
const onImportPhrase = fn<(phrase: string) => Promise<void>>(() => Promise.resolve());
/** What the site views ask of a site's sign-in. */
const onConsent = fn<() => void>();
const onDecline = fn<() => void>();
const onSiteConfirm = fn<() => void>();
const onSiteRetry = fn<() => void>();
const onSiteCancel = fn<() => void>();
/** What the site list asks of the grants. */
const onRevoke = fn<(token: string) => void>();
const onSiteListRetry = fn<() => void>();
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
    onConsent,
    onDecline,
    onSiteConfirm,
    onSiteRetry,
    onSiteCancel,
    onRevoke,
    onSiteListRetry,
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
      onConsent,
      onDecline,
      onSiteConfirm,
      onSiteRetry,
      onSiteCancel,
      onRevoke,
      onSiteListRetry,
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

function windowView(): HTMLElement {
  return byTestId('session-window');
}
function card(): HTMLElement {
  return byTestId('session-window-card');
}
function status(): HTMLElement {
  return byTestId('session-window-status');
}
function buttonNames(): string[] {
  return [...windowView().querySelectorAll('button')].map(button => button.textContent.trim());
}

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
};

/** As a user of a site whose return address it does not list, I am told it did not allow it and can only close. */
export const SiteNotAllowed: Story = {
  tags: ['!autodocs'],
  args: { screen: { view: 'site-not-allowed' } },
};

/** As a user whose browser cannot seal a redirect answer, I am told it cannot finish this sign-in and can only close. */
export const SiteUnsupported: Story = {
  tags: ['!autodocs'],
  args: { screen: { view: 'site-unsupported' } },
};

/** As a user who signed out, I see the window signing out with nothing to press until it is done. */
export const SigningOut: Story = {
  tags: ['!autodocs'],
  args: { screen: { view: 'signing-out' } },
};

/** As a user whose sign-out window told Polkadot App, I am told I am signed out everywhere and close the window. */
export const SignedOut: Story = {
  tags: ['!autodocs'],
  args: { screen: { view: 'signed-out' } },
};

/** As a phone user who signed out, I read that I am signed out and find Close this window after it. */
export const SignedOutPhone: Story = {
  tags: ['!autodocs'],
  globals: PHONE,
  args: { screen: { view: 'signed-out' }, isMobile: () => true },
};

/** As a user who signed in from a window no page opened, I am told I am signed in and to return to the app. */
export const DoneNoOpener: Story = {
  tags: ['!autodocs'],
  args: { screen: { ...SIGN_IN_START, view: 'done-no-opener' } },
};

/** As a phone user who signed in from a window no page opened, I am told to return to the app, with no button. */
export const DoneNoOpenerPhone: Story = {
  tags: ['!autodocs'],
  globals: PHONE,
  args: { screen: { ...SIGN_IN_START, view: 'done-no-opener' }, isMobile: () => true },
};

/** As a user already signed in, I see my account in the card and continue to the page or use another account. */
export const Continue: Story = {
  tags: ['!autodocs'],
  args: { screen: { ...SIGN_IN_START, view: 'continue', pageHost: 'browse.dot.li', offer: ALICE } },
};

/** As a phone user already signed in, I read my account first and find the two choices after it. */
export const ContinuePhone: Story = {
  tags: ['!autodocs'],
  globals: PHONE,
  args: {
    screen: { ...SIGN_IN_START, view: 'continue', pageHost: 'browse.dot.li', offer: ALICE },
    isMobile: () => true,
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
};

/** As a user whose sign-out of the stored account failed, I am told so and can try Use another account again. */
export const ContinueSignOutFailed: Story = {
  tags: ['!autodocs'],
  args: {
    screen: { ...SIGN_IN_START, view: 'continue', pageHost: 'browse.dot.li', offer: ALICE, failure: 'sign-out' },
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
};

/** As a user with no sign-in whom a site asks to sign in, I see the code to scan for the site's full origin. */
export const PairingSite: Story = {
  tags: ['!autodocs'],
  args: {
    screen: {
      ...SIGN_IN_START,
      view: 'pairing',
      pageHost: SITE_ORIGIN,
      pairing: { kind: 'pairing', payload: DEEPLINK },
    },
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
    const drawnWidths = (): number[] => drawQr.mock.calls.map(([{ options }]) => options.width);
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

/** The account the site named. */
const SITE_ACCOUNT = { product: 'myapp.dot', index: '0' };

/** What a site gets, as the consent view lists it. */
const SITE_GETS = ['Your username', 'The right to ask you to sign transactions, each confirmed again'];

/** What the consent view lists that a site gets, one list item each. */
function siteGets(): string[] {
  return within(byTestId('session-window-site-gets'))
    .getAllByRole('listitem')
    .map(item => item.textContent.trim());
}

/** As a user a site asks to sign in, I see the header, its full origin, what it gets and the buttons, and answer it. */
export const SiteConsent: Story = {
  tags: ['!autodocs'],
  args: { screen: { view: 'consent', origin: SITE_ORIGIN, group: null } },
  play: async ({ canvas, userEvent, step }) => {
    await step('Then the card heads with Sign in with Polkadot, names the site and lists what it gets', async () => {
      await expect(windowView()).toHaveAttribute('data-view', 'consent');
      await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('Sign in with Polkadot');
      await expect(byTestId('session-window-title')).toHaveTextContent('Sign in with Polkadot');
      await expect(byTestId('session-window-site')).toHaveTextContent(SITE_ORIGIN);
      await expectBefore(byTestId('session-window-title'), byTestId('session-window-site'));
      await expect(canvas.getByRole('heading', { level: 2 })).toHaveTextContent('This site gets');
      await expectBefore(byTestId('session-window-site'), byTestId('session-window-site-gets'));
      await expect(byTestId('session-window-site-gets')).toHaveAttribute('role', 'list');
      await expect(siteGets()).toEqual(SITE_GETS);
      await expect(canvas.queryByTestId('session-window-group')).toBeNull();
      await expect(canvas.queryByText(/wants you to sign in/)).toBeNull();
    });
    await step('Then Continue leads and Cancel follows, in the card', async () => {
      await expect(buttonNames()).toEqual(['Continue', 'Cancel']);
      await expect(card()).toContainElement(canvas.getByRole('button', { name: 'Cancel' }));
    });
    await step('When I press Continue', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Continue' }));
    });
    await step('Then the site sign-in was asked to go on once', async () => {
      await waitFor(() => expect(onConsent).toHaveBeenCalledTimes(1));
      await expect(onDecline).not.toHaveBeenCalled();
    });
    await step('When I press Cancel', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
    });
    await step('Then the site was declined once and no round of the window was cancelled', async () => {
      await waitFor(() => expect(onDecline).toHaveBeenCalledTimes(1));
      await expect(onSiteCancel).not.toHaveBeenCalled();
      await expect(onCancel).not.toHaveBeenCalled();
    });
  },
};

/**
 * As a user a site of a group asks to sign in, I see the Sign in with Polkadot header, its full origin and the
 * registrable domain the sign-in covers.
 */
export const SiteConsentGroup: Story = {
  tags: ['!autodocs'],
  args: { screen: { view: 'consent', origin: SITE_ORIGIN, group: 'site.example' } },
};

/** As a user signing a site in, the window shows Signing in for its origin and I can cancel. */
export const SiteSigning: Story = {
  tags: ['!autodocs'],
  args: { screen: { view: 'site-signing', origin: SITE_ORIGIN, route: 'auth' } },
};

/** As a user whose site sign-in failed, I am told so for its origin and try again or cancel. */
export const SiteFailed: Story = {
  tags: ['!autodocs'],
  args: { screen: { view: 'site-failed', origin: SITE_ORIGIN, route: 'auth', retry: true } },
  play: async ({ canvas, userEvent, step }) => {
    await step(
      'Then the window says the sign-in could not finish, in its tone, with Try again and Cancel',
      async () => {
        await expect(windowView()).toHaveAttribute('data-view', 'site-failed');
        await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('The sign-in could not finish');
        await expect(status()).toHaveAttribute('data-tone', 'err');
        await expect(status()).toHaveTextContent(SITE_ORIGIN);
        await expect(buttonNames()).toEqual(['Try again', 'Cancel']);
      },
    );
    await step('When I press Try again', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Try again' }));
    });
    await step('Then the site sign-in was asked to try again once, not the window flow', async () => {
      await waitFor(() => expect(onSiteRetry).toHaveBeenCalledTimes(1));
      await expect(onRetry).not.toHaveBeenCalled();
    });
    await step('When I press Cancel', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
    });
    await step('Then the site sign-in was cancelled once', async () => {
      await waitFor(() => expect(onSiteCancel).toHaveBeenCalledTimes(1));
      await expect(onCancel).not.toHaveBeenCalled();
    });
  },
};

/** As a user whose site asked for a transaction, I am told it is being prepared for its origin and can cancel. */
export const SitePreparingTransaction: Story = {
  tags: ['!autodocs'],
  args: { screen: { view: 'site-signing', origin: SITE_ORIGIN, route: 'sign' } },
};

/** As a user whose site transaction failed past trying again, I am told so for its origin and can only cancel. */
export const SiteTransactionFailed: Story = {
  tags: ['!autodocs'],
  args: { screen: { view: 'site-failed', origin: SITE_ORIGIN, route: 'sign', retry: false } },
};

/** A site's call with an argument whose value holds no break at all, and one whose text spans several lines. */
const LONG_CALL = {
  name: 'Utility.batch_all',
  args: [
    { name: 'remark', value: `0x${'ab'.repeat(120)}` },
    { name: 'calls', value: JSON.stringify([{ type: 'System', value: { type: 'remark' } }], null, 2) },
  ],
};

/** Each argument the review shows, as its name and its value. */
function reviewedArgs(): { name: string; value: string }[] {
  return within(byTestId('session-window-call'))
    .getAllByTestId('session-window-call-arg')
    .map(arg => ({
      name: within(arg).getByTestId('session-window-call-arg-name').textContent,
      value: within(arg).getByTestId('session-window-call-arg-value').textContent,
    }));
}

/** As a user a site asks to sign a long call, I read its origin, its name and every argument whole, and sign it. */
export const SiteReview: Story = {
  tags: ['!autodocs'],
  args: { screen: { view: 'site-review', origin: SITE_ORIGIN, call: LONG_CALL, account: SITE_ACCOUNT } },
  play: async ({ canvas, userEvent, step }) => {
    await step('Then the card heads with the full origin, says what the site asks and names the call', async () => {
      await expect(windowView()).toHaveAttribute('data-view', 'site-review');
      await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent(SITE_ORIGIN);
      await expect(byTestId('session-window-review')).toHaveTextContent(
        'asks you to sign a transaction with your myapp.dot account 0',
      );
      await expect(canvas.getByRole('heading', { level: 2 })).toHaveTextContent('Utility.batch_all');
    });
    await step('Then each argument shows whole, its value wrapped inside the card', async () => {
      await expect(reviewedArgs()).toEqual(LONG_CALL.args);
      const frame = card().getBoundingClientRect();
      for (const value of within(card()).getAllByTestId('session-window-call-arg-value')) {
        await expect(value).toBeVisible();
        const box = value.getBoundingClientRect();
        await expect(box.left).toBeGreaterThanOrEqual(frame.left);
        await expect(box.right).toBeLessThanOrEqual(frame.right);
        await expect(value.scrollWidth).toBeLessThanOrEqual(value.clientWidth);
      }
    });
    await step('Then Sign with Polkadot App leads and Cancel follows', async () => {
      await expect(buttonNames()).toEqual(['Sign with Polkadot App', 'Cancel']);
    });
    await step('When I press Sign with Polkadot App', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Sign with Polkadot App' }));
    });
    await step('Then the site round was asked to sign once', async () => {
      await waitFor(() => expect(onSiteConfirm).toHaveBeenCalledTimes(1));
      await expect(onSiteCancel).not.toHaveBeenCalled();
    });
    await step('When I press Cancel', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
    });
    await step('Then the site round was cancelled once and no round of the window was', async () => {
      await waitFor(() => expect(onSiteCancel).toHaveBeenCalledTimes(1));
      await expect(onCancel).not.toHaveBeenCalled();
    });
  },
};

/** As a user signing a site's transaction, I am told to approve it in Polkadot App for its origin and can cancel. */
export const SiteApproving: Story = {
  tags: ['!autodocs'],
  args: { screen: { view: 'site-approving', origin: SITE_ORIGIN } },
};

/** As a user signing a site's transaction, I am asked to open Polkadot App for its origin and can cancel. */
export const SiteSharing: Story = {
  tags: ['!autodocs'],
  args: { screen: { view: 'site-sharing', origin: SITE_ORIGIN } },
};

/** Two sites in the list, the most recently used first, as the grants store lists them. */
const SITES = [
  {
    token: 'token-newest',
    origin: SITE_ORIGIN,
    firstUsedAt: Date.UTC(2026, 8, 3),
    lastUsedAt: Date.UTC(2026, 9, 20),
    group: null,
  },
  {
    token: 'token-old',
    origin: 'https://old.example',
    firstUsedAt: Date.UTC(2026, 1, 14),
    lastUsedAt: Date.UTC(2026, 2, 1),
    group: null,
  },
];

/** A date as the site list writes it, in the reader's locale. */
function shownDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The rows of the site list, each one site. */
function siteRows(): HTMLElement[] {
  return [...byTestId('session-window-sites').querySelectorAll<HTMLElement>('[data-testid="session-window-site"]')];
}

/** As a user, I open my site list, read each site's origin and uses, and revoke one. */
export const SiteList: Story = {
  tags: ['!autodocs'],
  args: { screen: { view: 'sites', sites: SITES } },
  play: async ({ canvas, userEvent, step }) => {
    await step('Then the window heads its list and shows each site with its uses, the newest first', async () => {
      await expect(windowView()).toHaveAttribute('data-view', 'sites');
      await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('Sites you signed in to');
      const rows = siteRows();
      await expect(rows).toHaveLength(2);
      for (const [index, site] of SITES.entries()) {
        const row = within(must(rows[index], 'a site row'));
        await expect(row.getByTestId('session-window-site-origin')).toHaveTextContent(site.origin);
        await expect(row.getByText(`Since ${shownDate(site.firstUsedAt)}`)).toBeVisible();
        await expect(row.getByText(`Last used ${shownDate(site.lastUsedAt)}`)).toBeVisible();
      }
      await expect(buttonNames()).toEqual(['Revoke', 'Revoke']);
      await expect(canvas.queryByText('No site uses your Polkadot sign-in.')).toBeNull();
    });
    await step('When I press Revoke on the older site', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Revoke https://old.example' }));
    });
    await step('Then that site alone was revoked, once', async () => {
      await waitFor(() => expect(onRevoke).toHaveBeenCalledTimes(1));
      await expect(onRevoke).toHaveBeenCalledWith('token-old');
    });
  },
};

/** The origins of one site group, as its grant lists them, the one that made it first. */
const GROUP_ORIGINS = ['https://a.site.example', 'https://b.site.example', SITE_ORIGIN];

/** A site group three origins use, beside a site of no group. */
const GROUP_SITES = [
  {
    token: 'token-group',
    origin: 'https://a.site.example',
    firstUsedAt: Date.UTC(2026, 8, 3),
    lastUsedAt: Date.UTC(2026, 9, 20),
    group: { registrable: 'site.example', origins: GROUP_ORIGINS },
  },
  {
    token: 'token-old',
    origin: 'https://old.example',
    firstUsedAt: Date.UTC(2026, 1, 14),
    lastUsedAt: Date.UTC(2026, 2, 1),
    group: null,
  },
];

/** As a user, I read a site group in my list by its registrable domain and each origin, and revoke the group. */
export const SiteListGroup: Story = {
  tags: ['!autodocs'],
  args: { screen: { view: 'sites', sites: GROUP_SITES } },
  play: async ({ canvas, userEvent, step }) => {
    await step(
      'Then the group heads its row with its registrable domain, then each origin, then its uses',
      async () => {
        const rows = siteRows();
        await expect(rows).toHaveLength(2);
        const groupRow = must(rows[0], 'the group row');
        const row = within(groupRow);
        await expect(row.getByRole('heading')).toHaveTextContent('site.example');
        await expect(row.getAllByTestId('session-window-site-origin').map(origin => origin.textContent)).toEqual(
          GROUP_ORIGINS,
        );
        await expectBefore(
          row.getByRole('heading'),
          must(row.getAllByTestId('session-window-site-origin')[0], 'an origin'),
        );
        await expect(row.getByText(`Since ${shownDate(Date.UTC(2026, 8, 3))}`)).toBeVisible();
        await expect(row.getByText(`Last used ${shownDate(Date.UTC(2026, 9, 20))}`)).toBeVisible();
        await expect(row.getByRole('button', { name: 'Revoke site.example' })).toBeVisible();
      },
    );
    await step('Then the site of no group shows its origin alone, with no heading of a group', async () => {
      const row = within(must(siteRows()[1], 'the site row'));
      await expect(row.queryByRole('heading')).toBeNull();
      await expect(row.getByTestId('session-window-site-origin')).toHaveTextContent('https://old.example');
    });
    await step('When I press Revoke on the group', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Revoke site.example' }));
    });
    await step('Then the group alone was revoked, once', async () => {
      await waitFor(() => expect(onRevoke).toHaveBeenCalledTimes(1));
      await expect(onRevoke).toHaveBeenCalledWith('token-group');
    });
  },
};

/** As a user who signed in to no site, I am told no site uses my sign-in. */
export const SiteListEmpty: Story = {
  tags: ['!autodocs'],
  args: { screen: { view: 'sites', sites: [] } },
  play: async ({ canvas, step }) => {
    await step('Then the window heads its list, says no site uses my sign-in and offers no button', async () => {
      await expect(windowView()).toHaveAttribute('data-view', 'sites');
      await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('Sites you signed in to');
      await expect(canvas.getByText('No site uses your Polkadot sign-in.')).toBeVisible();
      await expect(canvas.queryByTestId('session-window-site')).toBeNull();
      await expect(buttonNames()).toEqual([]);
    });
  },
};

/** As a user whose site list could not be read, I am told so. */
export const SiteListFailed: Story = {
  tags: ['!autodocs'],
  args: { screen: { view: 'sites-failed' } },
  play: async ({ canvas, userEvent, step }) => {
    await step('Then the window says the list could not be read, in its tone, and lists no site', async () => {
      await expect(windowView()).toHaveAttribute('data-view', 'sites-failed');
      await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('Sites you signed in to');
      await expect(status()).toHaveAttribute('data-tone', 'err');
      await expect(canvas.getByRole('alert')).toHaveTextContent('The list could not be read');
      await expect(canvas.queryByTestId('session-window-site')).toBeNull();
      await expect(buttonNames()).toEqual(['Try again']);
    });
    await step('When I press Try again', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Try again' }));
    });
    await step('Then the list was asked to read again once, and no other flow was', async () => {
      await waitFor(() => expect(onSiteListRetry).toHaveBeenCalledTimes(1));
      await expect(onRetry).not.toHaveBeenCalled();
      await expect(onSiteRetry).not.toHaveBeenCalled();
    });
  },
};

/** The site list's view, which a story moves as its read is tried again. */
const [listScreen, setListScreen] = createSignal<SiteListScreen>({ view: 'sites-failed' });

/** As a keyboard user, I press Try again on a list that could not be read and keep focus in the window. */
export const RetryKeepsFocus: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    setListScreen({ view: 'sites-failed' });
  },
  render: args => (
    <SessionWindow
      {...args}
      screen={listScreen()}
      onSiteListRetry={() => {
        setListScreen({ view: 'sites-loading' });
      }}
    />
  ),
  play: async ({ canvas, userEvent, step }) => {
    let pressed: HTMLElement | undefined;
    await step('When I press Try again from the keyboard', async () => {
      pressed = canvas.getByRole('button', { name: 'Try again' });
      pressed.focus();
      await expect(pressed).toHaveFocus();
      await userEvent.keyboard('{Enter}');
    });
    await step('Then the button is gone and focus is on the window card, not the page', async () => {
      await waitFor(() => expect(pressed?.isConnected).toBe(false));
      await waitFor(() => expect(card()).toHaveFocus());
    });
  },
};

/** As a user whose site list is being read, I see it wait under its heading, never an empty list. */
export const SiteListLoading: Story = {
  tags: ['!autodocs'],
  args: { screen: { view: 'sites-loading' } },
};

/**
 * A long origin with no hyphen or space to break at, whose port comes last, as two sites on one host differ only
 * there.
 */
const LONG_ORIGIN = 'https://averylongsubdomainnamewithnobreak.ofasitewithalongname.example:8443';

/** As a user, I read a long origin in full, port included, inside the card, before I revoke it. */
export const SiteListLongOrigin: Story = {
  tags: ['!autodocs'],
  args: {
    screen: {
      view: 'sites',
      sites: [
        {
          token: 'token-long',
          origin: LONG_ORIGIN,
          firstUsedAt: Date.UTC(2026, 8, 3),
          lastUsedAt: Date.UTC(2026, 9, 20),
          group: null,
        },
      ],
    },
  },
  play: async ({ canvas, step }) => {
    await step('Then the whole origin shows, wrapped and not cut off, port included', async () => {
      const origin = byTestId('session-window-site-origin');
      await expect(origin).toHaveTextContent(LONG_ORIGIN);
      await expect(origin).toBeVisible();
      const box = origin.getBoundingClientRect();
      const frame = card().getBoundingClientRect();
      await expect(box.left).toBeGreaterThanOrEqual(frame.left);
      await expect(box.right).toBeLessThanOrEqual(frame.right);
      await expect(origin.scrollWidth).toBeLessThanOrEqual(origin.clientWidth);
      await expect(canvas.getByRole('button', { name: `Revoke ${LONG_ORIGIN}` })).toBeVisible();
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
