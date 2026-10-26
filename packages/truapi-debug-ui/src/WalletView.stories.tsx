// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { fakeDebugPanelHost } from '@dotli/truapi-debug-ui/testing';
import type { WalletSwitch } from './host.js';
import { WalletView } from './WalletView.js';
import { debugPanelStory } from './testing/stories/debug-panel-story.js';

const IDENTITY_ACCOUNT = `0x${'11'.repeat(32)}`;

/** The page's sign-in, which the panel only asks to open. */
const intents = {
  importPhrase: fn<WalletSwitch['importPhrase']>(),
  usePolkadotApp: fn<WalletSwitch['usePolkadotApp']>(),
};

/** The host page, its stores reset after each story. */
const page = fakeDebugPanelHost({ walletSwitch: intents });

const meta = {
  ...debugPanelStory,
  title: 'Debug/Wallet',
  component: WalletView,
  args: { active: true, host: page.host },
  // The tab gets the host itself rather than the args store's view of it.
  render: args => <WalletView active={args.active} host={page.host} />,
  beforeEach: () => resetAllStoresForTests,
} satisfies Meta<typeof WalletView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A local wallet is active for the page in this story. */
const localWallet = (): void => {
  page.walletMode.set({ mode: 'local', failure: null });
};

/** As a developer using the debug panel, I use a recovery phrase and the page's sign-in opens for it. */
export const PhraseOpensSignIn: Story = {
  tags: ['!autodocs'],
  play: async ({ canvas, userEvent, step }) => {
    await step('When I use a recovery phrase', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Use a recovery phrase' }));
    });
    await step("Then the page's sign-in is asked for once and no phrase is typed here", async () => {
      await expect(intents.importPhrase).toHaveBeenCalledTimes(1);
      await expect(canvas.queryByRole('textbox')).toBeNull();
    });
  },
};

/** As a developer using the debug panel, I am told what a local wallet is and warned that it is not secure. */
export const ExplainsAndWarns: Story = {
  play: async ({ canvas, step }) => {
    await step('Then I am told what a local wallet is and warned that it is not secure', async () => {
      await expect(canvas.getByTestId('td-wallet-about')).toHaveTextContent(
        'Copy the recovery phrase from Polkadot App',
      );
      await expect(canvas.getByTestId('td-wallet-warning')).toHaveTextContent(
        'Use it only for an account you can afford to lose.',
      );
    });
  },
};

/** As a developer using the debug panel, I see my local account and use Polkadot App, and the page signs me out. */
export const UsePolkadotAppSignsOut: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    localWallet();
    page.auth.set({
      tag: 'Connected',
      session: { identityAccountId: IDENTITY_ACCOUNT, liteUsername: 'alice.42' },
    });
  },
  play: async ({ canvas, userEvent, step }) => {
    await step('Given I see my account and username', async () => {
      await expect(canvas.getByTestId('td-wallet-account')).toHaveTextContent(IDENTITY_ACCOUNT);
      await expect(canvas.getByTestId('td-wallet-username')).toHaveTextContent('alice.42');
    });
    await step('When I use Polkadot App', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Use Polkadot App' }));
    });
    await step('Then the page signs out once', async () => {
      await expect(intents.usePolkadotApp).toHaveBeenCalledTimes(1);
    });
  },
};

/** As a developer using the debug panel, I replace my local wallet and the page's sign-in opens for the new phrase. */
export const ReplaceOpensSignIn: Story = {
  tags: ['!autodocs'],
  beforeEach: localWallet,
  play: async ({ canvas, userEvent, step }) => {
    await step('When I replace my wallet', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Replace' }));
    });
    await step("Then the page's sign-in is asked for once and Polkadot App is not", async () => {
      await expect(intents.importPhrase).toHaveBeenCalledTimes(1);
      await expect(intents.usePolkadotApp).not.toHaveBeenCalled();
    });
  },
};

/** As a developer using the debug panel, I see why my local wallet could not start. */
export const LocalWalletFailed: Story = {
  beforeEach: () => {
    page.walletMode.set({ mode: 'app', failure: 'Local wallet could not be decrypted and was forgotten' });
  },
  play: async ({ canvas, step }) => {
    await step('Then I see why my local wallet could not start', async () => {
      await waitFor(() =>
        expect(canvas.getByTestId('td-wallet-failure')).toHaveTextContent(
          'Local wallet could not be decrypted and was forgotten',
        ),
      );
    });
  },
};
