// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { byId, byTestId } from '@dotli/ui/testing';
import { isPhoneViewport, LayerTracker, Popover, type TrackedLayer } from '@dotli/ui';
import { expectBefore } from '@config/storybook/play';
import { expectPhone, openSurface, TopbarFrame } from '../../testing/stories/topbar-frame.js';
import {
  connect,
  disconnect,
  resetStoryAccount,
  storyAccount,
  storyCallbacks,
} from '../../testing/stories/account-fixtures.js';
import {
  CLOSED_MODAL,
  modalCallbacks,
  modalCalls,
  resetStoryModal,
  showModal,
  storyModal,
} from '../../testing/stories/auth-modal-fixtures.js';
import { AuthButton } from './AuthButton.js';
import type { AuthModalState, AuthModalView } from '../../state/auth-modal.js';
import { AuthModal } from './AuthModal.js';
import type { DrawQr } from './qr-code.js';
import { loadPhraseScreen, type PhraseScreenModule } from '../../lazy.js';

const open = openSurface({ surface: 'auth-modal-backdrop' });

const DEEPLINK = 'polkadotapp://pair?handshake=test';
const TITLE = 'Sign in with Polkadot App';
const PREPARING = 'Getting a sign-in code ready.';
const LONG_GET_APP = 'Get it for iPhone or Android';
const SHORT_GET_APP = 'Get it';
/** The body over the code to scan. */
const scanHint = (host: string): string => `Scan the code to continue to ${host}. One sign-in works across every app.`;
/** The body over a phone's app link. */
const appHint = (host: string): string =>
  `Approve in the app to continue to ${host}. One sign-in works across every app.`;

/** The QR renderer the modal is given, which draws nothing and records what it was asked. */
const drawQr = fn<DrawQr>(() => Promise.resolve());
/** Whether the modal takes this device for a phone, apart from the viewport's width. */
const device = { mobile: false };

/** The one phrase the page's check takes. */
const PHRASE = 'bottom drive obey lake curtain smoke basket hold race lonely fit walk';
/** The page's phrase import, which resolves as the page reloads into local mode. */
const onImportPhrase = fn<(phrase: string) => Promise<void>>(() => Promise.resolve());
/** The phrase form's loader the modal is given, which loads the form's own chunk unless a story says otherwise. */
const loadPhrase = fn<() => Promise<PhraseScreenModule>>(loadPhraseScreen);

/** Shows a pairing in the open modal. */
function pairing(extra: Partial<AuthModalState> = {}): void {
  showModal({
    open: true,
    productLabel: 'localhost:3000',
    reason: null,
    view: { kind: 'pairing', payload: DEEPLINK },
    ...extra,
  });
}

type ErrorView = Extract<AuthModalView, { kind: 'error' }>;

/** A login that failed for a reason the copy does not know, unless `view` says otherwise. */
function failed(view: Partial<ErrorView> = {}): void {
  showModal({
    open: true,
    productLabel: null,
    reason: null,
    view: {
      kind: 'error',
      message: 'Host failure',
      retry: true,
      pending: false,
      title: 'Sign-in did not complete',
      subtitle:
        'Something interrupted the connection to Polkadot App. Try again, and make sure the app is installed and up to date.',
      detail: 'Host failure',
      ...view,
    },
  });
}

/** Shows a view of the sign-in window round in the open modal. */
function windowRound(view: AuthModalView, extra: Partial<AuthModalState> = {}): void {
  showModal({ open: true, productLabel: null, reason: null, view, ...extra });
}

const body = within(document.body);
/** The modal's dialog, open or closed. */
const dialog = (): HTMLElement => byTestId('auth-modal-backdrop');
/** The title the card heads with, which names the dialog even while the closed dialog hides its name. */
const modalTitle = (): HTMLElement => within(dialog()).getByRole('heading', { level: 2, hidden: true });
/** The body under the pairing screen's title. */
const hint = (): HTMLElement => byTestId('auth-modal-hint');
/** The modal's own way out, shown or not. Its name follows the view. */
const closeButton = (name = 'Cancel'): HTMLElement => within(dialog()).getByRole('button', { name, hidden: true });
/** Where to get the app, whose name the device shortens. */
const GET_APP_NAME = /^Get it/;
const getAppLink = (): HTMLElement => body.getByRole('link', { name: GET_APP_NAME, hidden: true });
const queryGetAppLink = (): HTMLElement | null => body.queryByRole('link', { name: GET_APP_NAME, hidden: true });
/** The account button in the bar, while no one is signed in. */
const signInButton = (): HTMLElement => body.getByRole('button', { name: 'Sign in with Polkadot App' });
/** The modal's footer, where its answers sit. */
const actions = (): HTMLElement => byTestId('auth-modal-actions');
const isOpen = (): boolean => byId('auth-modal-backdrop').hasAttribute('data-open');
const qrBox = (): HTMLElement => byId('auth-modal-qr');
const qrCanvas = (): HTMLCanvasElement | null => body.queryByTestId('auth-modal-qr')?.querySelector('canvas') ?? null;
const drawnCanvases = (): HTMLCanvasElement[] => [...new Set(drawQr.mock.calls.map(([canvas]) => canvas))];
const drawnWidths = (): number[] => drawQr.mock.calls.map(([, , options]) => options.width);
const opened = (): Promise<void> => waitFor(() => expect(isOpen()).toBe(true));
const closed = (): Promise<void> => waitFor(() => expect(isOpen()).toBe(false));
/** The modal's buttons named `name`, shown or not, so a view offers one Cancel, not the frame's beside its own. */
const buttonsNamed = (name: string): HTMLElement[] => within(dialog()).queryAllByRole('button', { name, hidden: true });

/** The heading and links of the open pairing screen, with the frame's one Cancel. */
async function expectHead(want: { reason?: string; hint: string; getApp: string }): Promise<void> {
  const backdrop = byId('auth-modal-backdrop');
  await expect(backdrop).toHaveAttribute('role', 'dialog');
  await expect(backdrop).toHaveAttribute('aria-modal', 'true');
  await expect(backdrop).toHaveAttribute('aria-labelledby', 'auth-modal-title');
  await expect(modalTitle().textContent).toBe(TITLE);
  const reason = byId('auth-modal-reason');
  await expect(reason.hidden).toBe(want.reason === undefined);
  await expect(reason.textContent).toBe(want.reason ?? '');
  await expect(byId('auth-modal-hint')).toHaveTextContent(want.hint);
  const getApp = byId('auth-modal-get-app');
  await expect(getApp).toHaveAttribute('href', 'https://docs.polkadot.com/apps/');
  await expect(getApp).toHaveAttribute('target', '_blank');
  await expect(getApp).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(getApp).toHaveTextContent(want.getApp);
  await expect(byId('auth-modal-close')).toHaveTextContent('Cancel');
  await expect(buttonsNamed('Cancel')).toHaveLength(1);
  await expect(actions().firstElementChild).toBe(closeButton());
}

/** The spinner alone holds the code's place. */
async function expectSpinner(): Promise<void> {
  await expect(hint()).toHaveTextContent(PREPARING);
  await expect(qrBox().childElementCount).toBe(1);
  await expect(within(qrBox()).getByTestId('auth-modal-spinner')).toBeInTheDocument();
  await expect(qrCanvas()).toBeNull();
}

/** The layers the page's tracker holds, as the topbar counts them. */
const tracked = new Set<TrackedLayer>();
const anyTrackedOpen = (): boolean => [...tracked].some(layer => layer.open());

/** A button of the bar with its popover, as the topbar's own are. */
function PopoverInBar(): JSX.Element {
  const [trigger, setTrigger] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  return (
    <>
      <button ref={setTrigger} id="bar-button" type="button">
        Permissions
      </button>
      <Popover id="bar-popover" title="Permissions" trigger={trigger()}>
        <p>Granted to this app</p>
      </Popover>
    </>
  );
}

/** The page under the modal. The modal stands in the middle unless the story hangs it from the bar. */
function Shell(props: { placement?: 'center' | 'topbar-end'; children?: JSX.Element }): JSX.Element {
  return (
    <>
      <TopbarFrame>
        {props.children}
        <AuthButton
          account={storyAccount}
          modalOpen={() => storyModal().open}
          onSignIn={modalCallbacks.onSignIn}
          onLogout={storyCallbacks.onLogout}
          handOver={storyCallbacks.handOver}
        />
      </TopbarFrame>
      <LayerTracker
        value={layer => {
          tracked.add(layer);
          return () => tracked.delete(layer);
        }}
      >
        <AuthModal
          placement={props.placement ?? 'center'}
          state={storyModal}
          onClose={modalCallbacks.onClose}
          onRetry={modalCallbacks.onRetry}
          onFocusWindow={modalCallbacks.onFocusWindow}
          restoreFocus={storyCallbacks.restoreFocus}
          drawQr={drawQr}
          isMobile={() => device.mobile}
          isValidPhrase={phrase => phrase === PHRASE}
          onImportPhrase={onImportPhrase}
          loadPhraseScreen={loadPhrase}
        />
      </LayerTracker>
    </>
  );
}

const meta = {
  title: 'Host/AuthModal',
  component: Shell,
  parameters: { chrome: true, docs: { story: { inline: false, height: '560px' } } },
  // Boot found no saved session, until a story says otherwise.
  beforeEach: () => {
    drawQr.mockClear();
    drawQr.mockImplementation(() => Promise.resolve());
    loadPhrase.mockReset();
    loadPhrase.mockImplementation(loadPhraseScreen);
    device.mobile = false;
    resetStoryAccount();
    resetStoryModal();
    disconnect();
  },
  render: () => <Shell />,
} satisfies Meta<typeof Shell>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user asked to sign in by a product, I see the modal open on its QR under a body that names the product. */
export const Open: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    pairing();
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('Then it shows the QR under the body naming the product, with where to get the app', async () => {
      await waitFor(() => expect(qrCanvas()).not.toBeNull());
      await expectHead({ hint: scanHint('localhost:3000'), getApp: LONG_GET_APP });
    });
  },
};

/** As a phone user, I see the sign-in sheet headed by the view's title with a close button, and pressing it asks once to close. */
export const OpenPhone: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  beforeEach: () => {
    device.mobile = true;
    pairing();
  },
  play: async ctx => {
    await expectPhone(ctx.step);
    await open(ctx);
    const head = (): HTMLElement => body.getByTestId('auth-modal-sheet-head');
    await ctx.step('Then the sheet head carries the view title, which names the dialog', async () => {
      await expect(within(head()).getByRole('heading', { level: 2, name: TITLE })).toBeVisible();
      await expect(dialog()).toHaveAttribute('aria-labelledby', 'auth-modal-title');
      await expect(dialog()).toHaveAccessibleName(TITLE);
      await expectBefore(head(), hint());
    });
    await ctx.step('When I press its close button', async () => {
      const close = within(head()).getByTestId('auth-modal-sheet-close');
      await expect(close).toHaveAttribute('aria-label', 'Close');
      await ctx.userEvent.click(close);
    });
    await ctx.step('Then the sheet closed on one close asked for', async () => {
      await closed();
      await expect(modalCalls.closes).toBe(1);
    });
  },
};

/**
 * As a landing page visitor, I see the sign-in as a dialog in the middle of the page with the install link in its card
 * and Cancel among its answers, and pressing Cancel asks once to close.
 */
export const LandingDialog: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    pairing({ productLabel: null });
  },
  play: async ({ userEvent, step }) => {
    await step(
      'Then the dialog stands in the middle of the page over the dark scrim, with focus on Cancel',
      async () => {
        await opened();
        await waitFor(() => expect(closeButton()).toHaveFocus());
        await expect(dialog()).toHaveAttribute('data-layout', 'center');
        await expect(dialog()).toHaveAttribute('data-scrim', 'dark');
      },
    );
    await step('Then its card holds the heading, the code, the install link and then Cancel', async () => {
      const card = byTestId('auth-modal');
      await expect(card).toContainElement(qrBox());
      await expect(card).toContainElement(getAppLink());
      await expectBefore(getAppLink(), closeButton());
      await expectHead({ hint: 'Scan the code to sign in. One sign-in works across every app.', getApp: LONG_GET_APP });
    });
    await step('When I press Cancel', async () => {
      await userEvent.click(closeButton());
    });
    await step('Then it closed on one close asked for', async () => {
      await closed();
      await expect(modalCalls.closes).toBe(1);
    });
  },
};

/** As a visitor of a preview that pairs in place, I see the sign-in card hung from the bar over the light scrim. */
export const PreviewPairing: Story = {
  tags: ['!autodocs'],
  render: () => <Shell placement="topbar-end" />,
  beforeEach: () => {
    pairing();
  },
  play: async ({ step }) => {
    await step('Then the card hangs from the bar with the code, the install link and Cancel', async () => {
      await opened();
      await expect(dialog()).toHaveAttribute('data-layout', 'topbar-end');
      await expect(dialog()).toHaveAttribute('data-scrim', 'light');
      await expect(byTestId('auth-modal')).toContainElement(qrBox());
      await expectHead({ hint: scanHint('localhost:3000'), getApp: LONG_GET_APP });
    });
  },
};

/** As a keyboard user, I press Escape and the modal is asked once to close, and focus goes back to the auth button. */
export const EscapeCloses: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    pairing();
  },
  play: async ({ userEvent, step }) => {
    await step('Given the sign-in is open', opened);
    await step('When I press Escape', async () => {
      await userEvent.keyboard('{Escape}');
    });
    await step('Then it closed on one close asked for and gave focus back to the auth button', async () => {
      await closed();
      await expect(modalCalls.closes).toBe(1);
      await waitFor(() => expect(byId('auth-button')).toHaveFocus());
    });
  },
};

/** As a dotli user, I find the closed modal a dialog with its labels and ARIA state, and empty. */
export const ClosedIsEmpty: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('Then the closed dialog is labelled and holds no code', async () => {
      await expect(isOpen()).toBe(false);
      await expectHead({ hint: PREPARING, getApp: LONG_GET_APP });
      await expect(qrCanvas()).toBeNull();
      await expect(drawQr).not.toHaveBeenCalled();
    });
  },
};

/** As a desktop user, I see the login modal open on the spinner and then show the QR code. */
export const SpinnerThenQr: Story = {
  tags: ['!autodocs'],
  play: async ({ userEvent, step }) => {
    await step('When I press Sign in', async () => {
      await userEvent.click(byId('auth-button'));
    });
    await step('Then the modal opens on the spinner', async () => {
      await opened();
      await expectHead({ hint: PREPARING, getApp: LONG_GET_APP });
      await expectSpinner();
    });
    await step('When the pairing code arrives', () => {
      pairing({ productLabel: 'app.dot' });
    });
    await step('Then the QR is drawn once at the desktop size and shown, with the product named', async () => {
      await waitFor(() => expect(qrCanvas()).not.toBeNull());
      await expect(drawQr).toHaveBeenCalledTimes(1);
      await expect(drawQr).toHaveBeenCalledWith(
        qrCanvas(),
        DEEPLINK,
        { width: 300, margin: 2, errorCorrectionLevel: 'Q', color: { dark: '#000000', light: '#ffffff' } },
        expect.any(AbortSignal),
      );
      await expectHead({ hint: scanHint('app.dot'), getApp: LONG_GET_APP });
      const tile = within(qrBox()).getByTestId('auth-modal-qr-tile');
      await expect(qrCanvas()).toHaveAttribute('data-qr-payload', DEEPLINK);
      await expect(qrCanvas()).toHaveAttribute('role', 'img');
      await expect(qrCanvas()).toHaveAttribute('aria-label', 'Sign-in QR code');
      await expect(within(tile).getByTestId('auth-modal-qr-badge')).toHaveAttribute('aria-hidden', 'true');
    });
  },
};

/** As a user on a phone-width window, I see the QR code drawn at the one size it takes everywhere. */
export const PhoneQrSize: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  beforeEach: () => {
    pairing();
  },
  play: async ({ step }) => {
    await expectPhone(step);
    await step('Then the code is drawn once at 300 px', async () => {
      await waitFor(() => expect(drawQr).toHaveBeenCalledTimes(1));
      await expect(drawnWidths()).toEqual([300]);
    });
  },
};

/**
 * As a desktop user narrowing the window to a phone width and back, I keep the one open QR code, drawn once at 300 px,
 * as card and as sheet.
 */
export const NarrowAndWiden: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    pairing();
  },
  play: async ({ step }) => {
    const { page } = await import('vitest/browser');
    const wide = { width: window.innerWidth, height: window.innerHeight };
    try {
      await step('Given the code drawn at 300 px on a wide screen', async () => {
        await waitFor(() => expect(qrCanvas()).not.toBeNull());
        await expect(drawnWidths()).toEqual([300]);
      });
      const canvas = qrCanvas();
      await step('When the window narrows to a phone', async () => {
        await page.viewport(390, 844);
      });
      await step('Then the sheet shows the same canvas, drawn once', async () => {
        await waitFor(() => expect(body.getByTestId('auth-modal-sheet-head')).toBeVisible());
        await expect(drawnWidths()).toEqual([300]);
        await expect(drawnCanvases()).toEqual([canvas]);
        await expect(qrCanvas()).toBe(canvas);
      });
      await step('When it widens again', async () => {
        await page.viewport(wide.width, wide.height);
      });
      await step('Then the card shows the same canvas, drawn once', async () => {
        await waitFor(() => expect(body.queryByTestId('auth-modal-sheet-head')).toBeNull());
        await expect(drawnWidths()).toEqual([300]);
        await expect(drawnCanvases()).toEqual([canvas]);
        await expect(qrCanvas()).toBe(canvas);
      });
    } finally {
      await page.viewport(wide.width, wide.height);
    }
  },
};

/** As a user asked to sign in by a product, I read its name and why as text in the body. */
export const ProductNameAsText: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('When a product with markup in its name asks me to sign in, with a reason', () => {
      pairing({ productLabel: 'localhost:<b>x</b>', reason: '<i>to vote</i>' });
    });
    await step('Then the name and the reason are text', async () => {
      await opened();
      await expect(hint().querySelector('b')).toBeNull();
      await expect(byTestId('auth-modal-reason').querySelector('i')).toBeNull();
      await expectHead({
        reason: '<i>to vote</i>',
        hint: scanHint('localhost:<b>x</b>'),
        getApp: LONG_GET_APP,
      });
    });
  },
};

/** As a user who scanned the code, I am asked to approve on my phone in place of the QR, and can cancel. */
export const ProgressView: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    pairing({ productLabel: null });
  },
  play: async ({ step }) => {
    await step('Given the QR on show', async () => {
      await waitFor(() => expect(qrCanvas()).not.toBeNull());
    });
    await step('When the wallet approves', () => {
      showModal({ view: { kind: 'authenticating' } });
    });
    await step('Then the approval replaces the QR, signing in with one Cancel, and the modal still open', async () => {
      await waitFor(() => expect(dialog()).toHaveAccessibleName('Approve in Polkadot App'));
      await expect(dialog()).toHaveTextContent(
        "Check your phone and approve the sign-in. This closes when you're done.",
      );
      await expect(body.getByRole('status')).toHaveTextContent('Signing in…');
      await expect(body.getByTestId('auth-modal-spinner')).toBeInTheDocument();
      await expect(qrCanvas()).toBeNull();
      await expect(isOpen()).toBe(true);
      await expect(closeButton()).toHaveTextContent('Cancel');
      await expect(buttonsNamed('Cancel')).toHaveLength(1);
    });
  },
};

const failure = (): HTMLElement => body.getByTestId('auth-modal-failure');

/** As a new user, I see a failed login explained and press Try again to start over. */
export const ErrorViewRetry: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    failed();
  },
  play: async ({ userEvent, step }) => {
    await step('Then the error view explains it, keeps the reason and offers Try again', async () => {
      await opened();
      await expect(dialog()).toHaveAccessibleName('Sign-in did not complete');
      await expect(failure()).toHaveTextContent(
        'Something interrupted the connection to Polkadot App. Try again, and make sure the app is installed and up to date.',
      );
      await expect(body.getByTestId('auth-modal-error')).toHaveTextContent('Host failure');
      await expect(body.getByTestId('auth-modal-retry')).toHaveTextContent('Try again');
      await expect(closeButton()).toHaveTextContent('Cancel');
      await expect(buttonsNamed('Cancel')).toHaveLength(1);
    });
    await step('When I press Try again', async () => {
      await userEvent.click(body.getByTestId('auth-modal-retry'));
    });
    await step('Then one retry was asked for and the spinner is back', async () => {
      await waitFor(() => expect(modalCalls.retries).toBe(1));
      await expect(isOpen()).toBe(true);
      await waitFor(expectSpinner);
    });
  },
};

/** As a new user whose sign-in failed, I see the failure's tone, not the wait that says my account is being set up. */
export const ErrorViewFailedTone: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    failed({ title: 'Sign-in was declined', subtitle: 'The request was declined.' });
  },
  play: async ({ step }) => {
    await step('Then the failure is drawn in the failure tone', async () => {
      await opened();
      await expect(failure()).toHaveAttribute('data-tone', 'err');
    });
  },
};

/** As a new user whose account is still being set up, I see the warning tone, since I only have to wait. */
export const ErrorViewPendingTone: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    failed({ pending: true, title: 'Your account is still being set up', subtitle: 'Please try again later' });
  },
  play: async ({ step }) => {
    await step('Then the failure is drawn in the warning tone', async () => {
      await opened();
      await expect(failure()).toHaveAttribute('data-tone', 'warn');
    });
  },
};

const windowView = (): HTMLElement => body.getByTestId('auth-modal-window');

/** The head of a view of the sign-in window round: its own title, no code and no install link, and one close. */
async function expectWindowHead(want: { title: string; close: string }): Promise<void> {
  await expect(dialog()).toHaveAccessibleName(want.title);
  await expect(body.queryByTestId('auth-modal-hint')).toBeNull();
  await expect(queryGetAppLink()).toBeNull();
  await expect(byTestId('auth-modal-close')).toHaveTextContent(want.close);
  await expect(buttonsNamed(want.close)).toHaveLength(1);
  await expect(actions().firstElementChild).toBe(closeButton(want.close));
  await expect(dialog()).toHaveAttribute('data-layout', 'topbar-end');
  await expect(dialog()).toHaveAttribute('data-scrim', 'light');
  await expect(qrCanvas()).toBeNull();
}

/** As a user who pressed Sign in, I see the page wait for the sign-in window and bring that window to the front. */
export const WindowView: Story = {
  tags: ['!autodocs'],
  render: () => <Shell placement="topbar-end" />,
  beforeEach: () => {
    windowRound({ kind: 'window' });
  },
  play: async ({ userEvent, step }) => {
    await step('Then the page says to continue in the window, with a button that shows it', async () => {
      await opened();
      await expectWindowHead({ title: 'Continue in the sign-in window', close: 'Cancel' });
      await expect(windowView()).toHaveAttribute('data-view', 'window');
      await expect(windowView()).toHaveTextContent(
        "Sign in with Polkadot App in the window that opened. This page picks up your account once you're done.",
      );
      await expect(body.getByTestId('auth-modal-window-focus')).toHaveTextContent('Show the window');
    });
    await step('When I press Show the window', async () => {
      await userEvent.click(body.getByTestId('auth-modal-window-focus'));
    });
    await step('Then the window was asked to come to the front and the page still waits', async () => {
      await waitFor(() => expect(modalCalls.focuses).toBe(1));
      await expect(isOpen()).toBe(true);
    });
    await step('When I press Cancel', async () => {
      await userEvent.click(closeButton());
    });
    await step('Then one close was asked for and the modal closed', async () => {
      await closed();
      await expect(modalCalls.closes).toBe(1);
    });
  },
};

/** As a user whose browser blocked the sign-in window, I am told why and press Try again. */
export const BlockedView: Story = {
  tags: ['!autodocs'],
  render: () => <Shell placement="topbar-end" />,
  beforeEach: () => {
    windowRound({ kind: 'blocked' });
  },
  play: async ({ userEvent, step }) => {
    await step('Then the page says the window was blocked and offers Try again and Cancel', async () => {
      await opened();
      await expectWindowHead({ title: 'The sign-in window was blocked', close: 'Cancel' });
      await expect(windowView()).toHaveAttribute('data-view', 'blocked');
      await expect(windowView()).toHaveTextContent('Your browser stopped the window that signs you in.');
      await expect(body.getByTestId('auth-modal-window-retry')).toHaveTextContent('Try again');
      await expectBefore(closeButton(), body.getByTestId('auth-modal-window-retry'));
    });
    await step('When I press Try again', async () => {
      await userEvent.click(body.getByTestId('auth-modal-window-retry'));
    });
    await step('Then one new sign-in was asked for', async () => {
      await waitFor(() => expect(modalCalls.retries).toBe(1));
    });
    await step('When I press Cancel', async () => {
      await userEvent.click(closeButton());
    });
    await step('Then one close was asked for and the modal closed', async () => {
      await closed();
      await expect(modalCalls.closes).toBe(1);
    });
  },
};

/** As a user on a page the sign-in window refuses, I am told sign-in is not available here and can only close. */
export const RefusedView: Story = {
  tags: ['!autodocs'],
  render: () => <Shell placement="topbar-end" />,
  beforeEach: () => {
    windowRound({ kind: 'refused' });
  },
  play: async ({ userEvent, step }) => {
    await step('Then the page says sign-in is not available here, with Close and nothing to retry', async () => {
      await opened();
      await expectWindowHead({ title: 'Sign-in is not available here', close: 'Close' });
      await expect(windowView()).toHaveAttribute('data-view', 'refused');
      await expect(windowView()).toHaveTextContent('The sign-in window does not sign in pages at this address.');
      await expect(body.queryByTestId('auth-modal-window-retry')).toBeNull();
      await expect(buttonsNamed('Cancel')).toHaveLength(0);
    });
    await step('When I press Close', async () => {
      await userEvent.click(closeButton('Close'));
    });
    await step('Then one close was asked for and the modal closed', async () => {
      await closed();
      await expect(modalCalls.closes).toBe(1);
    });
  },
};

/** As a user asked by a product to sign in, I see Sign in to continue and press Sign in myself. */
export const PromptView: Story = {
  tags: ['!autodocs'],
  render: () => <Shell placement="topbar-end" />,
  beforeEach: () => {
    windowRound({ kind: 'prompt', resume: false }, { productLabel: 'localhost:3000' });
  },
  play: async ({ userEvent, step }) => {
    await step('Then the page asks me to sign in to continue, naming the product', async () => {
      await opened();
      await expectWindowHead({ title: 'Sign in to continue', close: 'Cancel' });
      await expect(windowView()).toHaveAttribute('data-view', 'prompt');
      await expect(windowView()).toHaveTextContent(
        'localhost:3000 needs your account. Sign in with Polkadot App in a new window.',
      );
      await expect(windowView()).not.toHaveAttribute('data-resume');
      await expect(body.getByTestId('auth-modal-window-signin')).toHaveTextContent('Sign in');
    });
    await step('When I press Sign in', async () => {
      await userEvent.click(body.getByTestId('auth-modal-window-signin'));
    });
    await step('Then one sign-in was asked for', async () => {
      await waitFor(() => expect(modalCalls.retries).toBe(1));
    });
  },
};

/**
 * As a user asked by a product to sign in while a sign-in made elsewhere waits, I am offered to continue it, with no
 * account named, and press Continue session myself.
 */
export const ResumePromptView: Story = {
  tags: ['!autodocs'],
  render: () => <Shell placement="topbar-end" />,
  beforeEach: () => {
    windowRound({ kind: 'prompt', resume: true }, { productLabel: 'localhost:3000' });
  },
  play: async ({ userEvent, step }) => {
    await step('Then the page offers to continue the sign-in made elsewhere in the product', async () => {
      await opened();
      await expectWindowHead({ title: 'Continue session', close: 'Cancel' });
      await expect(windowView()).toHaveAttribute('data-view', 'prompt');
      await expect(windowView()).toHaveAttribute('data-resume');
      await expect(windowView()).toHaveTextContent(
        "You're already signed in. Continue to use that account in localhost:3000.",
      );
      await expect(body.getByTestId('auth-modal-window-signin')).toHaveTextContent('Continue session');
    });
    await step('When I press Continue session', async () => {
      await userEvent.click(body.getByTestId('auth-modal-window-signin'));
    });
    await step('Then one sign-in was asked for', async () => {
      await waitFor(() => expect(modalCalls.retries).toBe(1));
    });
  },
};

/** As a user asked by a product to sign in, I press Cancel and the prompt is asked once to close, with no sign-in. */
export const PromptCancels: Story = {
  tags: ['!autodocs'],
  render: () => <Shell placement="topbar-end" />,
  beforeEach: () => {
    windowRound({ kind: 'prompt', resume: false }, { productLabel: 'localhost:3000' });
  },
  play: async ({ userEvent, step }) => {
    await step('When I press Cancel', async () => {
      await opened();
      await userEvent.click(closeButton());
    });
    await step('Then one close was asked for and no sign-in', async () => {
      await closed();
      await expect(modalCalls.closes).toBe(1);
      await expect(modalCalls.retries).toBe(0);
    });
  },
};

/** The phrase form, once its chunk has loaded. */
const phraseForm = (): Promise<HTMLElement> => body.findByTestId('auth-modal-phrase');

/** As a debug panel user, I retry a phrase form that failed to load and see it. */
export const PhraseFormRetry: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    loadPhrase.mockRejectedValueOnce(new Error('chunk'));
    windowRound({ kind: 'phrase' });
  },
  play: async ({ userEvent, step }) => {
    await step('Then the modal says the form could not load and offers Try again', async () => {
      await opened();
      await expect(await body.findByTestId('auth-modal-failure')).toHaveTextContent('Try again.');
      await expect(dialog()).toHaveAccessibleName('Something went wrong');
      await expect(loadPhrase).toHaveBeenCalledTimes(1);
    });
    await step('When I press Try again', async () => {
      await userEvent.click(body.getByTestId('auth-modal-retry'));
    });
    await step('Then the form shows, loaded again, and no new sign-in was asked for', async () => {
      await expect(await phraseForm()).toBeInTheDocument();
      await expect(dialog()).toHaveAccessibleName('Sign in with a recovery phrase');
      await expect(loadPhrase).toHaveBeenCalledTimes(2);
      await expect(modalCalls.retries).toBe(0);
    });
  },
};

/**
 * As a debug panel user on a page that pairs in place, I see the phrase form in the sign-in modal, with its Cancel in
 * the dismiss slot, and Cancel closes the modal.
 */
export const PhraseView: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    windowRound({ kind: 'phrase' });
  },
  play: async ({ userEvent, step }) => {
    await step('Then the modal shows the phrase form, named by its title, with its warning', async () => {
      await opened();
      await phraseForm();
      await expect(dialog()).toHaveAttribute('aria-labelledby', 'auth-modal-title');
      await expect(dialog()).toHaveAccessibleName('Sign in with a recovery phrase');
      await expect(actions().firstElementChild).toBe(byTestId('auth-modal-phrase-back'));
      await expect(actions()).toContainElement(body.getByRole('button', { name: 'Sign in' }));
      await expect(byTestId('auth-modal-phrase-warning')).toHaveTextContent('This is not secure.');
      await expect(body.queryByTestId('auth-modal-qr-tile')).toBeNull();
    });
    await step('When I cancel', async () => {
      await userEvent.click(byTestId('auth-modal-phrase-back'));
    });
    await step('Then one close was asked for and the modal closed', async () => {
      await closed();
      await expect(modalCalls.closes).toBe(1);
    });
  },
};

/**
 * As a user, I press Cancel and the pairing modal is asked once to close and fades out on the code it showed, and the
 * next sign-in opens on a new code.
 */
export const CancelCloses: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    pairing();
  },
  play: async ({ userEvent, step }) => {
    await step('When I press Cancel', async () => {
      await opened();
      await waitFor(() => expect(qrCanvas()).not.toBeNull());
      await userEvent.click(byId('auth-modal-close'));
    });
    await step('Then one close was asked for and the closed modal still shows the code it showed', async () => {
      await closed();
      await expect(modalCalls.closes).toBe(1);
      await expect(modalTitle().textContent).toBe(TITLE);
      await expect(hint()).toHaveTextContent(scanHint('localhost:3000'));
      await expect(qrCanvas()).not.toBeNull();
    });
    await step('When I press Sign in again', async () => {
      await userEvent.click(signInButton());
    });
    await step('Then the modal opens on a new code being made', async () => {
      await opened();
      await expectSpinner();
    });
  },
};

/** As a user whose sign-in completes, I see the modal fade out on the approval, not on the code being made. */
export const CompletionFadesOnApproval: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    showModal({ open: true, productLabel: null, reason: null, view: { kind: 'authenticating' } });
  },
  play: async ({ step }) => {
    await step('Given the approval on show', async () => {
      await opened();
      await expect(dialog()).toHaveAccessibleName('Approve in Polkadot App');
    });
    await step('When the session connects, which closes the modal', () => {
      showModal(CLOSED_MODAL);
    });
    await step('Then the closing modal still shows the approval', async () => {
      await closed();
      await expect(modalTitle().textContent).toBe('Approve in Polkadot App');
      await expect(body.getByRole('status', { hidden: true })).toHaveTextContent('Signing in…');
      await expect(body.queryByTestId('auth-modal-hint')).toBeNull();
    });
  },
};

/** As a user, I click the backdrop to close the modal and a click inside it leaves it open. */
export const BackdropCloses: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    pairing();
  },
  play: async ({ userEvent, step }) => {
    await step('When I click the title inside the card', async () => {
      await opened();
      await userEvent.click(byId('auth-modal-title'));
    });
    await step('Then it stays open', async () => {
      await expect(isOpen()).toBe(true);
    });
    await step('When I click the scrim around it', async () => {
      await userEvent.click(byTestId('auth-modal-scrim'));
    });
    await step('Then it closed on one close asked for', async () => {
      await closed();
      await expect(modalCalls.closes).toBe(1);
    });
  },
};

/** As a user, I cannot scroll the page behind the open modal, and I can again once it closes. */
export const ScrollLocked: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    pairing();
  },
  play: async ({ userEvent, step }) => {
    await step('Then the page is locked while the modal is open', async () => {
      await opened();
      await waitFor(() => expect(document.body).toHaveAttribute('data-scroll-locked'));
    });
    await step('When I press Cancel', async () => {
      await userEvent.click(byId('auth-modal-close'));
    });
    await step('Then the page scrolls again', async () => {
      await closed();
      await waitFor(() => expect(document.body).not.toHaveAttribute('data-scroll-locked'));
    });
  },
};

/** As a keyboard user, I press Try again and keep focus in the modal while the error view goes away. */
export const RetryKeepsFocus: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    failed();
  },
  play: async ({ userEvent, step }) => {
    const retry = (): HTMLElement => body.getByTestId('auth-modal-retry');
    let pressed: HTMLElement | undefined;
    await step('When I press Try again from the keyboard', async () => {
      await opened();
      pressed = retry();
      pressed.focus();
      await expect(pressed).toHaveFocus();
      await userEvent.keyboard('{Enter}');
    });
    await step('Then the button is gone and focus is on the modal card, not the page', async () => {
      await waitFor(() => expect(pressed?.isConnected).toBe(false));
      await expect(isOpen()).toBe(true);
      await waitFor(() => expect(body.getByTestId('auth-modal')).toHaveFocus());
    });
  },
};

/** As a user, I see the modal open focused and trapping Tab while an open popover of the bar closes for it. */
export const HoldsFocusOverPopover: Story = {
  tags: ['!autodocs'],
  render: () => (
    <Shell placement="topbar-end">
      <PopoverInBar />
    </Shell>
  ),
  play: async ({ userEvent, step }) => {
    const backdrop = (): HTMLElement => byId('auth-modal-backdrop');
    await step('Given a popover of the bar open', async () => {
      await userEvent.click(byId('bar-button'));
      await waitFor(() => expect(byId('bar-popover')).toHaveAttribute('data-open'));
    });
    await step('When a product asks for a login', () => {
      pairing();
    });
    await step('Then the popover closed and the modal is open with focus', async () => {
      await opened();
      await waitFor(() => expect(byId('bar-popover')).not.toHaveAttribute('data-open'));
      await waitFor(() => expect(backdrop().contains(document.activeElement)).toBe(true));
    });
    await step('When I Tab from Cancel', async () => {
      byId('auth-modal-close').focus();
      await userEvent.tab();
    });
    await step('Then focus is still in the modal', async () => {
      await expect(backdrop().contains(document.activeElement)).toBe(true);
    });
  },
};

/** As a user, I complete my login and the modal closes and focus goes back to the auth button. */
export const CompletionReturnsFocus: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    pairing();
  },
  play: async ({ step }) => {
    await step('Given focus in the open modal', async () => {
      await opened();
      await waitFor(() => expect(byId('auth-modal-backdrop').contains(document.activeElement)).toBe(true));
    });
    await step('When the session connects, which closes the modal', () => {
      connect({ liteUsername: 'pgherveou.04' });
      showModal(CLOSED_MODAL);
    });
    await step('Then the modal closed and focus is on the auth button', async () => {
      await closed();
      await waitFor(() => expect(byId('auth-button')).toHaveFocus());
    });
  },
};

/** As a dApp user, I am asked to sign in and the bar counts the modal as open until it closes, so the bar stays up. */
export const CountsAsOpenLayer: Story = {
  tags: ['!autodocs'],
  render: () => <Shell placement="topbar-end" />,
  play: async ({ userEvent, step }) => {
    await step('Given the bar counts nothing open', async () => {
      await expect(anyTrackedOpen()).toBe(false);
    });
    await step('When a product asks me to sign in', () => {
      pairing({ view: { kind: 'spinner' } });
    });
    await step('Then the modal is open and the bar counts it open', async () => {
      await opened();
      await expect(anyTrackedOpen()).toBe(true);
    });
    await step('When I press Cancel', async () => {
      await userEvent.click(byId('auth-modal-close'));
    });
    await step('Then the bar counts nothing open', async () => {
      await closed();
      await expect(anyTrackedOpen()).toBe(false);
    });
  },
};

/**
 * As a user asked to sign in while another prompt holds the queue, I see my pairing code drawn once, when the modal
 * opens.
 */
export const QueuedSignInDrawsQrOnce: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('When a product asks me to sign in while another prompt holds the queue', () => {
      pairing({ open: false });
    });
    await step('Then nothing opens and nothing is drawn yet', async () => {
      await expect(isOpen()).toBe(false);
      await expect(drawQr).not.toHaveBeenCalled();
    });
    await step('When the prompt ends and the modal takes its turn', () => {
      showModal({ open: true });
    });
    await step('Then the modal opens on its pairing code, drawn once', async () => {
      await opened();
      await waitFor(() => expect(qrCanvas()).not.toBeNull());
      await expect(drawQr).toHaveBeenCalledTimes(1);
      await expect(drawQr).toHaveBeenCalledWith(qrCanvas(), DEEPLINK, expect.any(Object), expect.any(AbortSignal));
    });
  },
};

/** As a new user on a phone without the app, I see where to get Polkadot App until the wallet approves. */
export const PhoneAppInstallLink: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    device.mobile = true;
    pairing();
  },
  play: async ({ step }) => {
    await step('Then the short install link shows', async () => {
      await opened();
      await waitFor(() => expect(getAppLink()).toHaveTextContent(SHORT_GET_APP));
      await expect(byId('auth-modal-get-app')).toHaveAttribute('href', 'https://docs.polkadot.com/apps/');
    });
    await step('When the wallet approves', () => {
      showModal({ view: { kind: 'authenticating' } });
    });
    await step('Then installing is no longer the ask', async () => {
      await waitFor(() => expect(queryGetAppLink()).toBeNull());
    });
  },
};

const openApp = (): HTMLElement => body.getByTestId('auth-modal-open-app');
const qrToggle = (): HTMLElement | null => body.queryByTestId('auth-modal-qr-toggle');

/**
 * As a phone user, I see Open Polkadot App among the answers and press Scan from another phone to see the QR, until a
 * new pairing starts over.
 */
export const DeeplinkFirst: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    device.mobile = true;
    pairing();
  },
  play: async ({ userEvent, step }) => {
    const deeplinkLeads = async (): Promise<void> => {
      await waitFor(() => expect(openApp()).toHaveAttribute('href', DEEPLINK));
      await expect(openApp()).toHaveTextContent('Open Polkadot App');
      const toggle = body.getByTestId('auth-modal-qr-toggle');
      await expectBefore(toggle, openApp());
      await expect(actions()).toContainElement(openApp());
      await expect(actions()).not.toContainElement(toggle);
      await expectBefore(closeButton(), openApp());
      await expectBefore(toggle, getAppLink());
      await expect(toggle).toHaveAttribute('type', 'button');
      await expect(toggle).toHaveTextContent('Scan from another phone');
      await expect(body.queryByRole('img', { name: 'Sign-in QR code' })).toBeNull();
      await expectHead({ hint: appHint('localhost:3000'), getApp: SHORT_GET_APP });
    };
    await step(
      'Then Open Polkadot App answers after Cancel, and Scan from another phone sits in the body',
      async () => {
        await opened();
        await deeplinkLeads();
      },
    );
    await step('When I press Scan from another phone', async () => {
      await userEvent.click(body.getByTestId('auth-modal-qr-toggle'));
    });
    await step('Then the QR, linked to the deeplink, shows before the app link, which stays', async () => {
      const qrLink = await waitFor(() => body.getByTestId('auth-modal-qr-link'));
      await expect(qrLink).toHaveAttribute('href', DEEPLINK);
      await expect(qrLink.querySelector('canvas')).toHaveAttribute('data-qr-payload', DEEPLINK);
      await expect(openApp()).toHaveAttribute('href', DEEPLINK);
      await expectBefore(qrLink, openApp());
      await expect(qrToggle()).toBeNull();
      await expect(hint()).toHaveTextContent(scanHint('localhost:3000'));
    });
    await step('When the wallet approves', () => {
      showModal({ view: { kind: 'authenticating' } });
    });
    await step('Then the approval shows and the install link goes', async () => {
      await waitFor(() => expect(body.getByRole('status')).toHaveTextContent('Signing in…'));
      await expect(dialog()).toHaveAccessibleName('Approve in Polkadot App');
      await expect(queryGetAppLink()).toBeNull();
    });
    await step('When a new pairing starts', () => {
      pairing();
    });
    await step('Then the deeplink leads again', deeplinkLeads);
  },
};

/**
 * As a user who narrows an open sign-in to a phone width, I see it become a sheet headed by the view's title, with a
 * close button.
 */
export const NarrowOpenBecomesSheet: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    pairing();
  },
  play: async ({ userEvent, step }) => {
    const { page } = await import('vitest/browser');
    const wide = { width: window.innerWidth, height: window.innerHeight };
    try {
      await step('Given the sign-in open on a wide screen', opened);
      await step('When the window narrows to a phone', async () => {
        await page.viewport(390, 844);
      });
      const head = (): HTMLElement => body.getByTestId('auth-modal-sheet-head');
      await step('Then the sheet is headed by the view title', async () => {
        await waitFor(() => expect(head()).toBeVisible());
        await expectBefore(head(), hint());
        await expect(within(head()).getByTestId('auth-modal-sheet-title')).toHaveTextContent(TITLE);
      });
      await step('When I press its close button', async () => {
        await userEvent.click(within(head()).getByTestId('auth-modal-sheet-close'));
      });
      await step('Then it closed on one close asked for', async () => {
        await closed();
        await expect(modalCalls.closes).toBe(1);
      });
    } finally {
      await page.viewport(wide.width, wide.height);
    }
  },
};

/**
 * As a keyboard user on a phone, I press Scan from another phone and keep focus in the sign-in while the button goes
 * away.
 */
export const ShowQrKeepsFocus: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    device.mobile = true;
    pairing();
  },
  play: async ({ userEvent, step }) => {
    let toggle: HTMLElement | undefined;
    await step('When I press Scan from another phone from the keyboard', async () => {
      await opened();
      toggle = await waitFor(() => body.getByTestId('auth-modal-qr-toggle'));
      toggle.focus();
      await expect(toggle).toHaveFocus();
      await userEvent.keyboard('{Enter}');
    });
    await step('Then the button is gone, the QR is in and focus is on the card', async () => {
      await waitFor(() => expect(toggle?.isConnected).toBe(false));
      await expect(body.getByTestId('auth-modal-qr-link')).toHaveAttribute('href', DEEPLINK);
      await waitFor(() => expect(body.getByTestId('auth-modal')).toHaveFocus());
    });
  },
};

/** As a phone user who presses Scan from another phone before the code exists, I see the code once it arrives. */
export const PhoneScanBeforeCode: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    device.mobile = true;
    showModal({ open: true, productLabel: 'localhost:3000', reason: null, view: { kind: 'spinner' } });
  },
  play: async ({ userEvent, step }) => {
    await step('When I press Scan from another phone while the code is being made', async () => {
      await opened();
      await expect(hint()).toHaveTextContent(PREPARING);
      await userEvent.click(await waitFor(() => body.getByTestId('auth-modal-qr-toggle')));
    });
    await step('Then the button is gone and the spinner holds the code place', async () => {
      await waitFor(() => expect(qrToggle()).toBeNull());
      await expect(qrBox().hidden).toBe(false);
      await expect(within(qrBox()).getByTestId('auth-modal-spinner')).toBeInTheDocument();
    });
    await step('When the code arrives', () => {
      pairing();
    });
    await step('Then the code shows, linked to the deeplink, with no button to show it again', async () => {
      const qrLink = await waitFor(() => body.getByTestId('auth-modal-qr-link'));
      await expect(qrLink).toHaveAttribute('href', DEEPLINK);
      await expect(qrBox().hidden).toBe(false);
      await expect(qrToggle()).toBeNull();
      await expect(hint()).toHaveTextContent(scanHint('localhost:3000'));
      await expect(drawQr).toHaveBeenCalledTimes(1);
    });
  },
};

/**
 * As a keyboard user, I keep focus in the sign-in as it moves from the code being made to the code, to approving and
 * to a failure.
 */
export const FocusFollowsViews: Story = {
  tags: ['!autodocs'],
  play: async ({ userEvent, step }) => {
    const inModal = (): boolean => dialog().contains(document.activeElement);
    await step('Given the sign-in opened on the code being made, with focus on Cancel', async () => {
      await userEvent.click(signInButton());
      await opened();
      await expectSpinner();
      await waitFor(() => expect(closeButton()).toHaveFocus());
    });
    await step('When the code arrives', () => {
      pairing();
    });
    await step('Then focus stays on Cancel', async () => {
      await waitFor(() => expect(qrCanvas()).not.toBeNull());
      await expect(closeButton()).toHaveFocus();
    });
    await step('When the wallet asks me to approve', () => {
      showModal({ view: { kind: 'authenticating' } });
    });
    await step('Then focus is on the card, not the page', async () => {
      await waitFor(() => expect(dialog()).toHaveAccessibleName('Approve in Polkadot App'));
      await waitFor(() => expect(byTestId('auth-modal')).toHaveFocus());
    });
    await step('When the sign-in fails', () => {
      failed();
    });
    await step('Then focus is still in the sign-in', async () => {
      await waitFor(() => expect(dialog()).toHaveAccessibleName('Sign-in did not complete'));
      await expect(inModal()).toBe(true);
      await expect(document.activeElement).not.toBe(document.body);
    });
  },
};

/**
 * As a user of a phone held sideways and wider than the phone layout, I see the sign-in as a card with Cancel and Open
 * Polkadot App among its answers.
 */
export const PhoneLandscapeOpenApp: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    device.mobile = true;
    pairing();
  },
  play: async ({ step }) => {
    const { page } = await import('vitest/browser');
    const wide = { width: window.innerWidth, height: window.innerHeight };
    try {
      await step('Given a phone held sideways, 844 px wide', async () => {
        await page.viewport(844, 390);
        await waitFor(() => expect(isPhoneViewport()).toBe(false));
      });
      await step('Then the card answers with Cancel, then Open Polkadot App', async () => {
        await opened();
        await waitFor(() => expect(openApp()).toHaveAttribute('href', DEEPLINK));
        await expect(body.queryByTestId('auth-modal-sheet-head')).toBeNull();
        await expect(actions()).toContainElement(openApp());
        await expect(actions()).toContainElement(closeButton());
        await expect(closeButton().compareDocumentPosition(openApp()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      });
    } finally {
      await page.viewport(wide.width, wide.height);
    }
  },
};

/** As a phone user who chose to scan from another phone, I keep seeing the QR while other modal fields change. */
export const QrStaysOnUnrelatedWrites: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    device.mobile = true;
    pairing();
  },
  play: async ({ userEvent, step }) => {
    await step('Given the QR shown in place of the app link first', async () => {
      await opened();
      await userEvent.click(await waitFor(() => body.getByTestId('auth-modal-qr-toggle')));
      await waitFor(() => expect(qrToggle()).toBeNull());
    });
    await step('When the modal reason changes', () => {
      showModal({ reason: 'first' });
    });
    await step('Then the QR, its link and its hint stay, drawn once', async () => {
      await waitFor(() => expect(byId('auth-modal-reason')).toHaveTextContent('first'));
      await expect(qrToggle()).toBeNull();
      await expect(body.getByTestId('auth-modal-qr-link')).toHaveAttribute('href', DEEPLINK);
      await expect(hint()).toHaveTextContent(scanHint('localhost:3000'));
      await expect(drawQr).toHaveBeenCalledTimes(1);
    });
  },
};
