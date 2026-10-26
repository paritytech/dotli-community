// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { CircleCheckIcon, CircleXIcon } from '@dotli/ui/icons';
import { byTestId } from '@dotli/ui/testing';
import { expectBefore } from '@config/storybook/play';
import { expectPhone } from '../../../testing/stories/topbar-frame.js';
import type { DrawQr } from '../qr-code.js';
import { PhraseScreen } from '../PhraseScreen.js';
import { WindowShell } from '../SessionWindow.js';
import { ApprovingScreen, ContinueScreen, PairingScreen, StatusScreen } from './SignInViews.js';

const HOST = 'host-playground.dot';
const DEEPLINK = 'polkadotapp://pair?handshake=test';
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const GET_APP_URL = 'https://docs.polkadot.com/apps/';
const PHONE = { viewport: { value: 'phone', isRotated: false } };

/** The QR renderer the screen is given, which draws nothing and records what it was asked. */
const drawQr = fn<DrawQr>(() => Promise.resolve());
const onCancel = fn<() => void>();
const onRetry = fn<() => void>();
const onClose = fn<() => void>();
const onContinue = fn<() => void>();
const onUseAnotherAccount = fn<() => void>();
const isValid = fn<(phrase: string) => boolean>();
const onImport = fn<(phrase: string) => Promise<void>>();
const onBack = fn<() => void>();

const meta = {
  title: 'Host/SignInViews',
  parameters: { chrome: true },
  beforeEach: () => {
    for (const mock of [onCancel, onRetry, onClose, onContinue, onUseAnotherAccount]) {
      mock.mockClear();
    }
    drawQr.mockClear();
    drawQr.mockImplementation(() => Promise.resolve());
    isValid.mockReset();
    isValid.mockImplementation(phrase => phrase === PHRASE);
    onImport.mockReset();
    onImport.mockImplementation(() => Promise.resolve());
    onBack.mockReset();
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const frame = (): HTMLElement => byTestId('session-window');
const buttonNames = (): string[] => [...frame().querySelectorAll('button')].map(button => button.textContent.trim());
const qrImage = (): HTMLElement | null => frame().querySelector('[role="img"][aria-label="Sign-in QR code"]');

async function expectGetApp(text: string): Promise<void> {
  const link = within(frame()).getByRole('link', { name: text });
  await expect(link).toHaveTextContent(text);
  await expect(link).toHaveAttribute('href', GET_APP_URL);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(link.parentElement).toHaveTextContent(`No Polkadot App yet? ${text}`);
}

/** As a desktop user, I see the code to scan for the page I sign in to, the two steps and where to get the app. */
export const Pairing: Story = {
  tags: ['!autodocs'],
  render: () => {
    const parts = PairingScreen({ payload: DEEPLINK, host: HOST, reason: null, mobile: false, drawQr });
    return <WindowShell view="pairing" parts={parts} />;
  },
  play: async ({ canvas, step }) => {
    await step('Then the code is drawn once and shown under the heading that names the page', async () => {
      await waitFor(() => expect(qrImage()).not.toBeNull());
      await expect(drawQr).toHaveBeenCalledTimes(1);
      await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('Sign in with Polkadot App');
      await expect(byTestId('auth-modal-hint')).toHaveTextContent(
        'Scan the code to continue to host-playground.dot. One sign-in works across every app.',
      );
      await expect(byTestId('auth-modal-reason')).not.toBeVisible();
      await expect(canvas.getByTestId('auth-modal-qr-tile')).toContainElement(qrImage());
      await expect(qrImage()).toHaveAttribute('data-qr-payload', DEEPLINK);
      await expect(canvas.getByTestId('auth-modal-qr-badge')).toHaveAttribute('aria-hidden', 'true');
    });
    await step('Then the two steps follow the code, with the install link and nothing to press', async () => {
      const steps = canvas.getAllByRole('listitem');
      await expect(steps).toHaveLength(2);
      await expect(steps[0]).toHaveTextContent('Scan QR code with your phone');
      await expect(steps[1]).toHaveTextContent('Approve');
      await expectBefore(canvas.getByTestId('auth-modal-qr-tile'), canvas.getByRole('list'));
      await expectGetApp('Get it for iPhone or Android');
      await expect(buttonNames()).toEqual([]);
    });
  },
};

/** As a desktop user, I see the code being made in its place, with no steps until it is ready. */
export const PairingPreparing: Story = {
  tags: ['!autodocs'],
  render: () => {
    const parts = PairingScreen({ payload: null, host: HOST, reason: null, mobile: false, drawQr });
    return <WindowShell view="pairing" parts={parts} />;
  },
  play: async ({ canvas, step }) => {
    await step('Then a spinner holds the code place and the body says the code is being made', async () => {
      await expect(byTestId('auth-modal-hint')).toHaveTextContent('Getting a sign-in code ready.');
      await expect(canvas.getByTestId('auth-modal-spinner')).toBeVisible();
      await expect(byTestId('auth-modal-qr')).toContainElement(canvas.getByTestId('auth-modal-spinner'));
      await expect(qrImage()).toBeNull();
      await expect(canvas.queryAllByRole('listitem')).toHaveLength(0);
      await expect(drawQr).not.toHaveBeenCalled();
    });
  },
};

/** As a user asked by a product with a reason, I read the reason under a body that names no page. */
export const PairingReasonNoHost: Story = {
  tags: ['!autodocs'],
  render: () => {
    const parts = PairingScreen({
      payload: DEEPLINK,
      host: null,
      reason: 'To vote on proposals',
      mobile: false,
      drawQr,
    });
    return <WindowShell view="pairing" parts={parts} />;
  },
  play: async ({ step }) => {
    await step('Then the body says to scan to sign in, with the reason under it', async () => {
      await expect(byTestId('auth-modal-hint')).toHaveTextContent(
        'Scan the code to sign in. One sign-in works across every app.',
      );
      await expect(byTestId('auth-modal-reason')).toBeVisible();
      await expect(byTestId('auth-modal-reason')).toHaveTextContent('To vote on proposals');
      await expectBefore(byTestId('auth-modal-hint'), byTestId('auth-modal-reason'));
    });
  },
};

/**
 * As a phone user, I see Open Polkadot App first and press Scan from another phone to see the code, linked to the app.
 */
export const PairingPhone: Story = {
  tags: ['!autodocs'],
  globals: PHONE,
  render: () => {
    const parts = PairingScreen({ payload: DEEPLINK, host: HOST, reason: null, mobile: true, drawQr });
    return <WindowShell view="pairing" parts={parts} />;
  },
  play: async ({ canvas, userEvent, step }) => {
    await expectPhone(step);
    const openApp = (): HTMLElement => canvas.getByRole('link', { name: 'Open Polkadot App' });
    await step('Then the app link leads, with Scan from another phone after it and no code on show', async () => {
      await expect(byTestId('auth-modal-hint')).toHaveTextContent(
        'Approve in the app to continue to host-playground.dot. One sign-in works across every app.',
      );
      await expect(openApp()).toHaveAttribute('href', DEEPLINK);
      await expect(openApp()).toHaveAttribute('data-testid', 'auth-modal-open-app');
      const scan = canvas.getByRole('button', { name: 'Scan from another phone' });
      await expect(scan).toHaveAttribute('data-testid', 'auth-modal-qr-toggle');
      await expectBefore(openApp(), scan);
      await expect(canvas.queryByRole('img', { name: 'Sign-in QR code' })).toBeNull();
      await expectGetApp('Get it');
    });
    await step('When I press Scan from another phone', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Scan from another phone' }));
    });
    await step('Then the code shows as a link to the app, the body says to scan and the app link stays', async () => {
      const link = await waitFor(() => canvas.getByTestId('auth-modal-qr-link'));
      await expect(link).toHaveAttribute('href', DEEPLINK);
      await expect(link).toContainElement(qrImage());
      await expect(canvas.getByRole('img', { name: 'Sign-in QR code' })).toBeVisible();
      await expect(byTestId('auth-modal-hint')).toHaveTextContent(
        'Scan the code to continue to host-playground.dot. One sign-in works across every app.',
      );
      await expect(canvas.queryByRole('button', { name: 'Scan from another phone' })).toBeNull();
      await expect(openApp()).toHaveAttribute('href', DEEPLINK);
      await expect(drawQr).toHaveBeenCalledTimes(1);
    });
  },
};

/** As a phone user whose code is still being made, I see Open Polkadot App wait for it, with nothing to open yet. */
export const PairingPhonePreparing: Story = {
  tags: ['!autodocs'],
  globals: PHONE,
  render: () => {
    const parts = PairingScreen({ payload: null, host: null, reason: null, mobile: true, drawQr });
    return <WindowShell view="pairing" parts={parts} />;
  },
  play: async ({ canvas, step }) => {
    await expectPhone(step);
    await step('Then Open Polkadot App is not yet a link and cannot be pressed', async () => {
      await expect(byTestId('auth-modal-hint')).toHaveTextContent('Getting a sign-in code ready.');
      await expect(canvas.queryByRole('link', { name: 'Open Polkadot App' })).toBeNull();
      await expect(canvas.getByRole('button', { name: 'Open Polkadot App' })).toBeDisabled();
      await expect(canvas.getByRole('button', { name: 'Scan from another phone' })).toBeEnabled();
    });
  },
};

/** As a user who scanned the code, I am asked to approve on my phone, see it signing in and can cancel. */
export const Approving: Story = {
  tags: ['!autodocs'],
  render: () => {
    const parts = ApprovingScreen({ closesCopy: "This window closes when you're done.", onCancel });
    return <WindowShell view="pairing" parts={parts} />;
  },
  play: async ({ canvas, userEvent, step }) => {
    await step('Then I am asked to approve in the app, with the sign-in under way and Cancel alone', async () => {
      await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('Approve in Polkadot App');
      await expect(frame()).toHaveTextContent(
        "Check your phone and approve the sign-in. This window closes when you're done.",
      );
      await expect(canvas.getByRole('status')).toHaveTextContent('Signing in…');
      await expect(canvas.getByTestId('auth-modal-spinner')).toBeVisible();
      await expect(buttonNames()).toEqual(['Cancel']);
    });
    await step('When I press Cancel', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
    });
    await step('Then the sign-in was asked to cancel once', async () => {
      await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    });
  },
};

/** As a phone user who scanned the code, I am asked to approve in the app and can cancel. */
export const ApprovingPhone: Story = {
  tags: ['!autodocs'],
  globals: PHONE,
  render: () => {
    const parts = ApprovingScreen({ closesCopy: "This closes when you're done.", onCancel });
    return <WindowShell view="pairing" parts={parts} />;
  },
  play: async ({ canvas, userEvent, step }) => {
    await expectPhone(step);
    await step('Then the body ends in what closes when I am done', async () => {
      await expect(frame()).toHaveTextContent(
        "Check your phone and approve the sign-in. This closes when you're done.",
      );
    });
    await step('When I press Cancel', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
    });
    await step('Then the sign-in was asked to cancel once', async () => {
      await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    });
  },
};

const declined = (): ReturnType<typeof StatusScreen> =>
  StatusScreen({
    mark: { icon: CircleXIcon, tone: 'err' },
    title: 'Sign-in was declined',
    body: 'The request was declined in Polkadot App. Start again and approve it on your phone.',
    detail: 'Rejected',
    actions: [{ label: 'Try again', primary: true, onPress: onRetry, testId: 'status-retry' }],
    testId: 'status',
    titleId: 'status-title',
  });

/** As a user whose sign-in was declined, I see why in the failure's tone, with the raw reason, and try again. */
export const StatusDeclined: Story = {
  tags: ['!autodocs'],
  render: () => {
    const parts = declined();
    return <WindowShell view="pairing" parts={parts} />;
  },
  play: async ({ canvas, userEvent, step }) => {
    await step('Then the failure says why, keeps the reason and offers Try again alone', async () => {
      const status = canvas.getByTestId('status');
      const title = canvas.getByRole('heading', { level: 1 });
      await expect(status).toHaveAttribute('data-tone', 'err');
      await expect(title).toHaveTextContent('Sign-in was declined');
      await expect(title).toHaveAttribute('id', 'status-title');
      await expect(status).toHaveTextContent(
        'The request was declined in Polkadot App. Start again and approve it on your phone.',
      );
      await expect(status).toHaveTextContent('Rejected');
      await expect(buttonNames()).toEqual(['Try again']);
    });
    await step('When I press Try again', async () => {
      await userEvent.click(canvas.getByTestId('status-retry'));
    });
    await step('Then one new try was asked for', async () => {
      await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
    });
  },
};

/** As a phone user whose sign-in was declined, I see the same failure and can try again. */
export const StatusDeclinedPhone: Story = {
  tags: ['!autodocs'],
  globals: PHONE,
  render: () => {
    const parts = declined();
    return <WindowShell view="pairing" parts={parts} />;
  },
  play: async ({ canvas, userEvent, step }) => {
    await expectPhone(step);
    await step('Then the failure shows in its tone', async () => {
      await expect(canvas.getByTestId('status')).toHaveAttribute('data-tone', 'err');
    });
    await step('When I press Try again', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Try again' }));
    });
    await step('Then one new try was asked for', async () => {
      await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
    });
  },
};

/** As a user whose window waits, I see a spinner over where it stands and can close it, as a page heading. */
export const StatusWaiting: Story = {
  tags: ['!autodocs'],
  render: () => {
    const parts = StatusScreen({
      mark: 'spinner',
      title: 'Connecting',
      body: 'Waiting for the page that opened this window.',
      actions: [{ label: 'Close', onPress: onClose }],
      testId: 'status',
      spinnerTestId: 'status-spinner',
    });
    return <WindowShell view="connecting" parts={parts} />;
  },
  play: async ({ canvas, userEvent, step }) => {
    await step('Then a spinner shows with the title as the page heading and Close alone', async () => {
      await expect(canvas.getByTestId('status-spinner')).toBeVisible();
      await expect(canvas.getByTestId('status')).not.toHaveAttribute('data-tone');
      await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('Connecting');
      await expect(buttonNames()).toEqual(['Close']);
    });
    await step('When I press Close', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Close' }));
    });
    await step('Then a close was asked for once', async () => {
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });
  },
};

/** As a phone user signed in from a window no page opened, I am told so with nothing to press. */
export const StatusDonePhone: Story = {
  tags: ['!autodocs'],
  globals: PHONE,
  render: () => {
    const parts = StatusScreen({
      mark: { icon: CircleCheckIcon, tone: 'ok' },
      title: "You're signed in",
      body: 'Return to the app.',
      testId: 'status',
    });
    return <WindowShell view="done-no-opener" parts={parts} />;
  },
  play: async ({ canvas, step }) => {
    await expectPhone(step);
    await step('Then the status shows in the done tone with no button', async () => {
      await expect(canvas.getByTestId('status')).toHaveAttribute('data-tone', 'ok');
      await expect(canvas.getByTestId('status')).toHaveTextContent('Return to the app.');
      await expect(canvas.queryByRole('button')).toBeNull();
    });
  },
};

const PAIRED = { wallet: 'paired', account: { liteUsername: 'alice.01' } } as const;

/** As a user already signed in, I see my account, what the page may ask of it, and continue or use another one. */
export const Continue: Story = {
  tags: ['!autodocs'],
  render: () => {
    const parts = ContinueScreen({ offer: PAIRED, host: HOST, failure: null, onContinue, onUseAnotherAccount });
    return <WindowShell view="continue" parts={parts} />;
  },
  play: async ({ canvas, userEvent, step }) => {
    await step('Then my account shows under Already signed in, with what the page may ask', async () => {
      await expect(canvas.getByTestId('session-window-continue')).toHaveTextContent('Already signed in');
      await expect(canvas.getByTestId('session-window-avatar')).toHaveAttribute('data-size', 'lg');
      await expect(canvas.getByTestId('session-window-title')).toHaveTextContent('alice.01');
      await expect(canvas.queryByTestId('session-window-local')).toBeNull();
      await expect(canvas.getByTestId('session-window-note')).toHaveTextContent(
        'host-playground.dot can ask this account to sign. Polkadot App asks you before each one.',
      );
      await expect(canvas.queryByRole('alert')).toBeNull();
      await expect(buttonNames()).toEqual(['Continue to host-playground.dot', 'Use another account']);
    });
    await step('When I press Continue to host-playground.dot', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Continue to host-playground.dot' }));
    });
    await step('Then continuing was asked for once', async () => {
      await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
      await expect(onUseAnotherAccount).not.toHaveBeenCalled();
    });
    await step('When I press Use another account', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Use another account' }));
    });
    await step('Then another account was asked for once', async () => {
      await waitFor(() => expect(onUseAnotherAccount).toHaveBeenCalledTimes(1));
    });
  },
};

/** As a phone user already signed in, I continue with my account. */
export const ContinuePhone: Story = {
  tags: ['!autodocs'],
  globals: PHONE,
  render: () => {
    const parts = ContinueScreen({ offer: PAIRED, host: HOST, failure: null, onContinue, onUseAnotherAccount });
    return <WindowShell view="continue" parts={parts} />;
  },
  play: async ({ canvas, userEvent, step }) => {
    await expectPhone(step);
    await step('When I press Continue to host-playground.dot', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Continue to host-playground.dot' }));
    });
    await step('Then continuing was asked for once', async () => {
      await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
    });
  },
};

/** As a user with a local wallet and no page named, I see it marked local, with a plain Continue. */
export const ContinueLocalNoHost: Story = {
  tags: ['!autodocs'],
  render: () => {
    const parts = ContinueScreen({
      offer: { wallet: 'local', account: null },
      host: null,
      failure: null,
      onContinue,
      onUseAnotherAccount,
    });
    return <WindowShell view="continue" parts={parts} />;
  },
  play: async ({ canvas, step }) => {
    await step('Then the wallet is named generically, marked local, and Continue names no page', async () => {
      await expect(canvas.getByTestId('session-window-title')).toHaveTextContent('Recovery phrase wallet');
      await expect(canvas.getByTestId('session-window-local')).toHaveTextContent('Local account');
      await expect(canvas.getByTestId('session-window-note')).toHaveTextContent(
        'Apps can ask this account to sign. Polkadot App asks you before each one.',
      );
      await expect(buttonNames()).toEqual(['Continue', 'Use another account']);
    });
  },
};

/** As a user whose step failed, I am told so as an alert, with both choices still there. */
export const ContinueFailure: Story = {
  tags: ['!autodocs'],
  render: () => {
    const parts = ContinueScreen({
      offer: PAIRED,
      host: HOST,
      failure: 'This account could not be signed out. Try again.',
      onContinue,
      onUseAnotherAccount,
    });
    return <WindowShell view="continue" parts={parts} />;
  },
  play: async ({ canvas, step }) => {
    await step('Then the failure is an alert and both choices stay', async () => {
      await expect(canvas.getByRole('alert')).toHaveTextContent('This account could not be signed out. Try again.');
      await expect(canvas.getByRole('alert')).toHaveAttribute('data-testid', 'session-window-failure');
      await expect(buttonNames()).toEqual(['Continue to host-playground.dot', 'Use another account']);
    });
  },
};

/** The phrase form as the window gives it to the screen, with every intent recorded. */
const phraseParts = (): ReturnType<typeof PhraseScreen> =>
  PhraseScreen({ isValid, onImport, onBack, backLabel: 'Back', testId: 'session-window-phrase' });

const phraseInput = (): HTMLElement => byTestId('session-window-phrase-input');

/** As a developer with a recovery phrase, I am told words that are not a phrase are not valid, and nothing is imported. */
export const PhraseInvalid: Story = {
  tags: ['!autodocs'],
  render: () => {
    const parts = phraseParts();
    return <WindowShell view="phrase" parts={parts} />;
  },
  play: async ({ canvas, userEvent, step }) => {
    await step('When I sign in with words that are not a phrase', async () => {
      await userEvent.type(phraseInput(), 'not a phrase');
      await userEvent.click(canvas.getByRole('button', { name: 'Sign in' }));
    });
    await step('Then I am told it is not valid and nothing is imported', async () => {
      await expect(await canvas.findByRole('alert')).toHaveTextContent('Not a valid recovery phrase');
      await expect(onImport).not.toHaveBeenCalled();
    });
  },
};

/** As a developer with a recovery phrase, I sign in with a valid one and it is imported once. */
export const PhraseImported: Story = {
  tags: ['!autodocs'],
  render: () => {
    const parts = phraseParts();
    return <WindowShell view="phrase" parts={parts} />;
  },
  play: async ({ canvas, userEvent, step }) => {
    await step('When I sign in with a valid phrase', async () => {
      await userEvent.type(phraseInput(), PHRASE);
      await userEvent.click(canvas.getByRole('button', { name: 'Sign in' }));
    });
    await step('Then it is imported once, with no error left', async () => {
      await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
      await expect(onImport).toHaveBeenCalledWith(PHRASE);
      await expect(canvas.queryByRole('alert')).toBeNull();
    });
  },
};

/** As a developer whose phrase wallet could not be saved, I am told so and can sign in again. */
export const PhraseSaveFailed: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    onImport.mockImplementation(() => Promise.reject(new Error('quota')));
  },
  render: () => {
    const parts = phraseParts();
    return <WindowShell view="phrase" parts={parts} />;
  },
  play: async ({ canvas, userEvent, step }) => {
    await step('When I sign in with a valid phrase that cannot be saved', async () => {
      await userEvent.type(phraseInput(), PHRASE);
      await userEvent.click(canvas.getByRole('button', { name: 'Sign in' }));
    });
    await step('Then I am told the wallet could not be saved and can sign in again', async () => {
      await expect(await canvas.findByRole('alert')).toHaveTextContent('The wallet could not be saved. Try again.');
      await waitFor(() => expect(canvas.getByRole('button', { name: 'Sign in' })).toBeEnabled());
    });
  },
};

/** As a developer with a recovery phrase, I press Back and the form is asked to go back once. */
export const PhraseBack: Story = {
  tags: ['!autodocs'],
  render: () => {
    const parts = phraseParts();
    return <WindowShell view="phrase" parts={parts} />;
  },
  play: async ({ canvas, userEvent, step }) => {
    await step('When I press Back', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Back' }));
    });
    await step('Then going back was asked for once', async () => {
      await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
    });
  },
};
