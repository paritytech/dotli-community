// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { LayerTracker, Popover, type TrackedLayer } from '@dotli/ui';
import { expectPhone, openSurface, TopbarFrame } from '../../../.storybook/topbar-frame.js';
import {
  connect,
  disconnect,
  resetStoryAccount,
  storyAccount,
  storyCallbacks,
} from '../../../.storybook/account-fixtures.js';
import {
  CLOSED_MODAL,
  modalCallbacks,
  modalCalls,
  resetStoryModal,
  showModal,
  storyModal,
} from '../../../.storybook/auth-modal-fixtures.js';
import { AuthButton } from './AuthButton.js';
import type { AuthModalState } from '../../state/auth-modal.js';
import { AuthModal } from './AuthModal.js';
import type { DrawQr } from './qr-code.js';

const open = openSurface({ surface: 'auth-modal-backdrop' });

const DEEPLINK = 'polkadotapp://pair?handshake=test';
const DESKTOP_HINT = 'Scan with Polkadot Mobile to connect';
const MOBILE_HINT = 'Sign in with the Polkadot app on this device';
const HOST_GLOBAL_TITLE = 'Login with Polkadot Mobile';

/** The QR renderer the modal is given, which draws nothing and records what it was asked. */
const drawQr = fn<DrawQr>(() => Promise.resolve());
/** Whether the modal takes this device for a phone, apart from the viewport's width. */
const device = { mobile: false };

/** A pairing on show, as the controller writes it once the modal holds the lease. */
function pairing(extra: Partial<AuthModalState> = {}): void {
  showModal({
    open: true,
    productLabel: 'localhost:3000',
    reason: null,
    view: { kind: 'pairing', payload: DEEPLINK },
    ...extra,
  });
}

/** A login that failed for a reason the copy does not know. */
function failed(): void {
  showModal({
    open: true,
    productLabel: null,
    reason: null,
    view: {
      kind: 'error',
      message: 'Host failure',
      retry: true,
      title: 'Login did not complete',
      subtitle:
        'Something interrupted the connection to Polkadot Mobile. Try again, and make sure the app is installed and up to date.',
      detail: 'Host failure',
    },
  });
}

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`No #${id}`);
  }
  return found;
}

const body = within(document.body);
const isOpen = (): boolean => el('auth-modal-backdrop').hasAttribute('data-open');
const qrBox = (): HTMLElement => el('auth-modal-qr');
const qrCanvas = (): HTMLCanvasElement | null => qrBox().querySelector('canvas');
const drawnCanvases = (): HTMLCanvasElement[] => [...new Set(drawQr.mock.calls.map(([canvas]) => canvas))];
const drawnWidths = (): number[] => drawQr.mock.calls.map(([, , options]) => options.width);
const opened = (): Promise<void> => waitFor(() => expect(isOpen()).toBe(true));
const closed = (): Promise<void> => waitFor(() => expect(isOpen()).toBe(false));

/** The head and links of the open modal. */
async function expectHead(want: {
  title: string;
  reason?: string;
  hint: string;
  getAppHidden: boolean;
}): Promise<void> {
  const backdrop = el('auth-modal-backdrop');
  await expect(backdrop).toHaveAttribute('role', 'dialog');
  await expect(backdrop).toHaveAttribute('aria-modal', 'true');
  await expect(backdrop).toHaveAttribute('aria-labelledby', 'auth-modal-title');
  await expect(el('auth-modal-title').textContent).toBe(want.title);
  const reason = el('auth-modal-reason');
  await expect(reason.hidden).toBe(want.reason === undefined);
  await expect(reason.textContent).toBe(want.reason ?? '');
  await expect(el('auth-modal-hint')).toHaveTextContent(want.hint);
  const getApp = el('auth-modal-get-app');
  await expect(getApp.hidden).toBe(want.getAppHidden);
  await expect(getApp).toHaveAttribute('href', 'https://docs.polkadot.com/apps/');
  await expect(getApp).toHaveAttribute('target', '_blank');
  await expect(getApp).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(getApp).toHaveTextContent("Don't have the app? Get Polkadot Mobile");
  await expect(el('auth-modal-close')).toHaveTextContent('Cancel');
}

/** The spinner alone holds the code's place. */
async function expectSpinner(): Promise<void> {
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

function Shell(props: { children?: JSX.Element }): JSX.Element {
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
          state={storyModal}
          onClose={modalCallbacks.onClose}
          onRetry={modalCallbacks.onRetry}
          restoreFocus={storyCallbacks.restoreFocus}
          drawQr={drawQr}
          isMobile={() => device.mobile}
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
    device.mobile = false;
    resetStoryAccount();
    resetStoryModal();
    disconnect();
  },
  render: () => <Shell />,
} satisfies Meta<typeof Shell>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user asked to sign in by a product, the modal opens on its QR under the product's name. */
export const Open: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    pairing();
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('Then it shows the QR under the product name, with the scan hint', async () => {
      await waitFor(() => expect(qrCanvas()).not.toBeNull());
      await expectHead({ title: 'localhost:3000 wants you to sign in', hint: DESKTOP_HINT, getAppHidden: true });
    });
  },
};

/** As a phone user, the sign-in sheet is headed Sign in with a close button, which asks once to close it. */
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
    await ctx.step('Then the sheet head leads, titled Sign in, above the product title', async () => {
      await expect(body.getByTestId('auth-modal').firstElementChild).toBe(head());
      const title = within(head()).getByTestId('auth-modal-sheet-title');
      await expect(title.tagName).toBe('H2');
      await expect(title).toHaveTextContent('Sign in');
      await expect(el('auth-modal-title').textContent).toBe('localhost:3000 wants you to sign in');
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

/** As a keyboard user, Escape asks once to close the modal, and focus goes back to the auth button. */
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
      await waitFor(() => expect(el('auth-button')).toHaveFocus());
    });
  },
};

/** As a dotli user, the closed modal is a dialog with its labels and ARIA state, and empty. */
export const ClosedIsEmpty: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('Then the closed dialog is labelled and holds no code', async () => {
      await expect(isOpen()).toBe(false);
      await expectHead({ title: HOST_GLOBAL_TITLE, hint: DESKTOP_HINT, getAppHidden: true });
      await expect(qrBox().childNodes).toHaveLength(0);
    });
  },
};

/** As a desktop user, the login modal opens on the spinner, then shows the QR code. */
export const SpinnerThenQr: Story = {
  tags: ['!autodocs'],
  play: async ({ userEvent, step }) => {
    await step('When I press Sign in', async () => {
      await userEvent.click(el('auth-button'));
    });
    await step('Then the modal opens on the spinner', async () => {
      await opened();
      await expectHead({ title: HOST_GLOBAL_TITLE, hint: DESKTOP_HINT, getAppHidden: true });
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
        { width: 218, margin: 2, errorCorrectionLevel: 'Q', color: { dark: '#000000', light: '#ffffff' } },
        expect.any(AbortSignal),
      );
      await expectHead({ title: 'app.dot wants you to sign in', hint: DESKTOP_HINT, getAppHidden: true });
      const tile = within(qrBox()).getByTestId('auth-modal-qr-tile');
      await expect(qrCanvas()).toHaveAttribute('data-qr-payload', DEEPLINK);
      await expect(qrCanvas()).toHaveAttribute('role', 'img');
      await expect(qrCanvas()).toHaveAttribute('aria-label', 'Sign-in QR code');
      await expect(tile.lastElementChild).toHaveAttribute('aria-hidden', 'true');
      await expect(within(qrBox()).getByTestId('auth-modal-waiting')).toHaveTextContent('Waiting for your phone');
    });
  },
};

/** As a user on a phone-width window, the QR code is drawn at the phone sheet's larger size. */
export const PhoneQrSize: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  beforeEach: () => {
    pairing();
  },
  play: async ({ step }) => {
    await expectPhone(step);
    await step('Then the code is drawn once at 248 px', async () => {
      await waitFor(() => expect(drawQr).toHaveBeenCalledTimes(1));
      await expect(drawnWidths()).toEqual([248]);
    });
  },
};

/** As a desktop user narrowing the window to a phone width and back, the open QR code is redrawn at each size. */
export const NarrowAndWiden: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    pairing();
  },
  play: async ({ step }) => {
    const { page } = await import('vitest/browser');
    const wide = { width: window.innerWidth, height: window.innerHeight };
    try {
      await step('Given the code drawn at the desktop size', async () => {
        await waitFor(() => expect(qrCanvas()).not.toBeNull());
        await expect(drawnWidths()).toEqual([218]);
      });
      const canvas = qrCanvas();
      await step('When the window narrows to a phone', async () => {
        await page.viewport(390, 844);
      });
      await step('Then the same canvas is redrawn at 248 px', async () => {
        await waitFor(() => expect(drawnWidths().at(-1)).toBe(248));
        await expect(drawnCanvases()).toEqual([canvas]);
        await expect(qrCanvas()).toBe(canvas);
      });
      await step('When it widens again', async () => {
        await page.viewport(wide.width, wide.height);
      });
      await step('Then the same canvas is redrawn at 218 px', async () => {
        await waitFor(() => expect(drawnWidths().at(-1)).toBe(218));
        await expect(drawnCanvases()).toEqual([canvas]);
        await expect(qrCanvas()).toBe(canvas);
      });
    } finally {
      await page.viewport(wide.width, wide.height);
    }
  },
};

/** As a user asked to sign in by a product, the title names it and shows why, as text. */
export const ProductTitleAsText: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('When a product with markup in its name asks me to sign in, with a reason', () => {
      showModal({ open: true, productLabel: 'localhost:<b>x</b>', reason: '<i>to vote</i>' });
    });
    await step('Then the title and reason are text, over the spinner', async () => {
      await opened();
      await expect(el('auth-modal-title').querySelector('b')).toBeNull();
      await expectHead({
        title: 'localhost:<b>x</b> wants you to sign in',
        reason: '<i>to vote</i>',
        hint: DESKTOP_HINT,
        getAppHidden: true,
      });
      await expectSpinner();
    });
  },
};

/** As a user who approved in the wallet, login progress replaces the pairing QR. */
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
    await step('Then login progress replaces the QR, with the modal still open', async () => {
      await waitFor(() => expect(qrBox()).toHaveTextContent('Logging in...'));
      await expect(within(qrBox()).getByTestId('auth-modal-spinner')).toBeInTheDocument();
      await expect(qrCanvas()).toBeNull();
      await expect(isOpen()).toBe(true);
      await expectHead({ title: HOST_GLOBAL_TITLE, hint: DESKTOP_HINT, getAppHidden: true });
    });
  },
};

/** As a new user, a failed login shows the error view, and Retry starts over. */
export const ErrorViewRetry: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    failed();
  },
  play: async ({ userEvent, step }) => {
    const failure = (): HTMLElement => within(qrBox()).getByTestId('auth-modal-failure');
    await step('Then the error view explains it, keeps the reason and offers Retry', async () => {
      await opened();
      await expectHead({ title: HOST_GLOBAL_TITLE, hint: DESKTOP_HINT, getAppHidden: true });
      await expect(failure().firstElementChild?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
      await expect(failure()).toHaveTextContent('Login did not complete');
      await expect(failure()).toHaveTextContent(
        'Something interrupted the connection to Polkadot Mobile. Try again, and make sure the app is installed and up to date.',
      );
      await expect(within(qrBox()).getByTestId('auth-modal-error')).toHaveTextContent('Host failure');
      await expect(within(qrBox()).getByTestId('auth-modal-retry')).toHaveTextContent('Retry');
    });
    await step('When I press Retry', async () => {
      await userEvent.click(within(qrBox()).getByTestId('auth-modal-retry'));
    });
    await step('Then one retry was asked for and the spinner is back', async () => {
      await waitFor(() => expect(modalCalls.retries).toBe(1));
      await expect(isOpen()).toBe(true);
      await waitFor(expectSpinner);
    });
  },
};

/** As a user, Cancel asks once to close the pairing modal, which closes empty. */
export const CancelCloses: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    pairing();
  },
  play: async ({ userEvent, step }) => {
    await step('When I press Cancel', async () => {
      await opened();
      await userEvent.click(el('auth-modal-close'));
    });
    await step('Then one close was asked for and the modal closed, empty', async () => {
      await closed();
      await expect(modalCalls.closes).toBe(1);
      await waitFor(() => expect(qrBox().children).toHaveLength(0));
    });
  },
};

/** As a user, a click on the backdrop itself closes the modal, and a click inside it does not. */
export const BackdropCloses: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    pairing();
  },
  play: async ({ userEvent, step }) => {
    await step('When I click the title inside the card', async () => {
      await opened();
      await userEvent.click(el('auth-modal-title'));
    });
    await step('Then it stays open', async () => {
      await expect(isOpen()).toBe(true);
    });
    await step('When I click the scrim around it', async () => {
      const scrim = el('auth-modal-backdrop').firstElementChild;
      if (scrim === null) {
        throw new Error('No scrim');
      }
      await userEvent.click(scrim);
    });
    await step('Then it closed on one close asked for', async () => {
      await closed();
      await expect(modalCalls.closes).toBe(1);
    });
  },
};

/** As a user, the page does not scroll behind the open modal, and scrolls again once it closes. */
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
      await userEvent.click(el('auth-modal-close'));
    });
    await step('Then the page scrolls again', async () => {
      await closed();
      await waitFor(() => expect(document.body).not.toHaveAttribute('data-scroll-locked'));
    });
  },
};

/** As a keyboard user, Retry keeps focus in the modal while the error view it sat in goes away. */
export const RetryKeepsFocus: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    failed();
  },
  play: async ({ userEvent, step }) => {
    const retry = (): HTMLElement => within(qrBox()).getByTestId('auth-modal-retry');
    let pressed: HTMLElement | undefined;
    await step('When I press Retry from the keyboard', async () => {
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

/** As a user, the modal opens focused and trapping Tab while an open popover of the bar closes for it. */
export const HoldsFocusOverPopover: Story = {
  tags: ['!autodocs'],
  render: () => (
    <Shell>
      <PopoverInBar />
    </Shell>
  ),
  play: async ({ userEvent, step }) => {
    const backdrop = (): HTMLElement => el('auth-modal-backdrop');
    await step('Given a popover of the bar open', async () => {
      await userEvent.click(el('bar-button'));
      await waitFor(() => expect(el('bar-popover')).toHaveAttribute('data-open'));
    });
    await step('When a product asks for a login', () => {
      pairing();
    });
    await step('Then the popover closed and the modal is open with focus', async () => {
      await opened();
      await waitFor(() => expect(el('bar-popover')).not.toHaveAttribute('data-open'));
      await waitFor(() => expect(backdrop().contains(document.activeElement)).toBe(true));
    });
    await step('When I Tab from Cancel', async () => {
      el('auth-modal-close').focus();
      await userEvent.tab();
    });
    await step('Then focus is still in the modal', async () => {
      await expect(backdrop().contains(document.activeElement)).toBe(true);
    });
  },
};

/** As a user, when my login completes the modal closes and focus goes back to the auth button. */
export const CompletionReturnsFocus: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    pairing();
  },
  play: async ({ step }) => {
    await step('Given focus in the open modal', async () => {
      await opened();
      await waitFor(() => expect(el('auth-modal-backdrop').contains(document.activeElement)).toBe(true));
    });
    await step('When the session connects, which closes the modal', () => {
      connect({ liteUsername: 'pgherveou.04' });
      showModal(CLOSED_MODAL);
    });
    await step('Then the modal closed and focus is on the auth button', async () => {
      await closed();
      await waitFor(() => expect(el('auth-button')).toHaveFocus());
    });
  },
};

/** As a user whose pairing started before the islands loaded, the modal is open with the QR as it mounts. */
export const PairedBeforeMount: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    pairing();
  },
  play: async ({ step }) => {
    await step('Then it is open with the product named and the QR in', async () => {
      await opened();
      await expect(el('auth-modal-title').textContent).toBe('localhost:3000 wants you to sign in');
      await waitFor(() => expect(qrCanvas()).not.toBeNull());
    });
  },
};

/** As a dApp user, a sign-in counts as an open layer of the bar from opening until it closes, so the bar stays up. */
export const CountsAsOpenLayer: Story = {
  tags: ['!autodocs'],
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
      await userEvent.click(el('auth-modal-close'));
    });
    await step('Then the bar counts nothing open', async () => {
      await closed();
      await expect(anyTrackedOpen()).toBe(false);
    });
  },
};

/** As a user asked to sign in while another prompt holds the queue, my pairing code is drawn once, when the modal opens. */
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

/** As a new user on a phone without the app, the login modal shows me where to get Polkadot Mobile until the wallet approves. */
export const PhoneAppInstallLink: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    device.mobile = true;
    pairing();
  },
  play: async ({ step }) => {
    await step('Then the install link shows', async () => {
      await opened();
      await waitFor(() => expect(el('auth-modal-get-app').hidden).toBe(false));
      await expect(el('auth-modal-get-app')).toHaveAttribute('href', 'https://docs.polkadot.com/apps/');
    });
    await step('When the wallet approves', () => {
      showModal({ view: { kind: 'authenticating' } });
    });
    await step('Then installing is no longer the ask', async () => {
      await waitFor(() => expect(el('auth-modal-get-app').hidden).toBe(true));
    });
  },
};

/** As a desktop user scanning with my phone, the modal does not offer an app install link. */
export const DesktopNoInstallLink: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    pairing();
  },
  play: async ({ step }) => {
    await step('Then the install link is hidden', async () => {
      await opened();
      await expect(el('auth-modal-get-app').hidden).toBe(true);
    });
  },
};

/** As a phone user, the deeplink leads and the QR is behind Show QR instead, until a new pairing starts over. */
export const DeeplinkFirst: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    device.mobile = true;
    pairing();
  },
  play: async ({ userEvent, step }) => {
    const openApp = (): HTMLElement => within(qrBox()).getByTestId('auth-modal-open-app');
    const deeplinkLeads = async (): Promise<void> => {
      await waitFor(() => expect(openApp()).toHaveAttribute('href', DEEPLINK));
      await expect(openApp()).toHaveTextContent('Login With Polkadot App');
      await expect(qrBox().firstElementChild).toBe(openApp());
      const toggle = within(qrBox()).getByTestId('auth-modal-qr-toggle');
      await expect(toggle).toHaveAttribute('type', 'button');
      await expect(toggle).toHaveTextContent('Show QR instead');
      await expect(qrCanvas()).toBeNull();
      await expectHead({
        title: 'localhost:3000 wants you to sign in',
        hint: MOBILE_HINT,
        getAppHidden: false,
      });
    };
    await step('Then the deeplink leads, with Show QR instead under it', async () => {
      await opened();
      await deeplinkLeads();
    });
    await step('When I press Show QR instead', async () => {
      await userEvent.click(within(qrBox()).getByTestId('auth-modal-qr-toggle'));
    });
    await step('Then the QR, linked to the deeplink, is on top and the deeplink is a link under it', async () => {
      const qrLink = within(qrBox()).getByTestId('auth-modal-qr-link');
      await expect(qrLink).toHaveAttribute('href', DEEPLINK);
      await expect(qrLink.querySelector('canvas')).toHaveAttribute('data-qr-payload', DEEPLINK);
      await expect(within(qrBox()).getByTestId('auth-modal-waiting')).toHaveTextContent('Waiting for your phone');
      await expect(qrBox().lastElementChild).toBe(openApp());
      await expect(qrBox().querySelector('[data-testid="auth-modal-qr-toggle"]')).toBeNull();
      await expect(el('auth-modal-hint')).toHaveTextContent(DESKTOP_HINT);
    });
    await step('When the wallet approves', () => {
      showModal({ view: { kind: 'authenticating' } });
    });
    await step("Then progress shows, the QR's hint stays and the install link goes", async () => {
      await waitFor(() => expect(qrBox()).toHaveTextContent('Logging in...'));
      await expectHead({ title: 'localhost:3000 wants you to sign in', hint: DESKTOP_HINT, getAppHidden: true });
    });
    await step('When a new pairing starts', () => {
      pairing();
    });
    await step('Then the deeplink leads again', deeplinkLeads);
  },
};

/** As a user who narrows an open sign-in to a phone width, the sheet it becomes is headed Sign in with a close button. */
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
      await step('Then the sheet is headed Sign in', async () => {
        await waitFor(() => expect(body.getByTestId('auth-modal').firstElementChild).toBe(head()));
        await expect(within(head()).getByTestId('auth-modal-sheet-title')).toHaveTextContent('Sign in');
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

/** As a keyboard user on a phone, Show QR instead keeps focus in the sign-in while the button goes away. */
export const ShowQrKeepsFocus: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    device.mobile = true;
    pairing();
  },
  play: async ({ userEvent, step }) => {
    let toggle: HTMLElement | undefined;
    await step('When I press Show QR instead from the keyboard', async () => {
      await opened();
      toggle = await waitFor(() => within(qrBox()).getByTestId('auth-modal-qr-toggle'));
      toggle.focus();
      await expect(toggle).toHaveFocus();
      await userEvent.keyboard('{Enter}');
    });
    await step('Then the button is gone, the QR is in and focus is on the card', async () => {
      await waitFor(() => expect(toggle?.isConnected).toBe(false));
      await expect(within(qrBox()).getByTestId('auth-modal-qr-link').tagName).toBe('A');
      await waitFor(() => expect(body.getByTestId('auth-modal')).toHaveFocus());
    });
  },
};

/** As a phone user who chose Show QR instead, the QR stays shown while other modal fields change. */
export const QrStaysOnUnrelatedWrites: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    device.mobile = true;
    pairing();
  },
  play: async ({ userEvent, step }) => {
    await step('Given the QR shown instead of the deeplink', async () => {
      await opened();
      await userEvent.click(await waitFor(() => within(qrBox()).getByTestId('auth-modal-qr-toggle')));
      await waitFor(() => expect(qrBox().querySelector('[data-testid="auth-modal-qr-toggle"]')).toBeNull());
    });
    await step('When the modal reason changes', () => {
      showModal({ reason: 'first' });
    });
    await step('Then the QR, its link and its hint stay, drawn once', async () => {
      await waitFor(() => expect(el('auth-modal-reason')).toHaveTextContent('first'));
      await expect(qrBox().querySelector('[data-testid="auth-modal-qr-toggle"]')).toBeNull();
      await expect(within(qrBox()).getByTestId('auth-modal-qr-link')).toHaveAttribute('href', DEEPLINK);
      await expect(el('auth-modal-hint')).toHaveTextContent(DESKTOP_HINT);
      await expect(drawQr).toHaveBeenCalledTimes(1);
    });
  },
};
