// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { fakeDebugPanelHost } from '@dotli/truapi-debug-ui/testing';
import type { WalletSwitch, WalletSwitchOutcome } from './host.js';
import { WalletView } from './WalletView.js';
import { debugPanelStory } from './testing/stories/debug-panel-story.js';

const IDENTITY_ACCOUNT = `0x${'11'.repeat(32)}`;

/** The wallet layer, which reports its own failures and answers whether the page is reloading. */
const intents = {
  useLocalWallet: fn<WalletSwitch['useLocalWallet']>(() => Promise.resolve('reloading')),
  usePolkadotApp: fn<WalletSwitch['usePolkadotApp']>(() => Promise.resolve('reloading')),
};

const failed = (): Promise<WalletSwitchOutcome> => Promise.resolve('failed');

/** The one phrase the stand-in host accepts, and the entropy it stands for. */
const PHRASE = 'bottom drive obey lake curtain smoke basket hold race lonely fit walk';
const ENTROPY = new Uint8Array(16).fill(7);

/** The host's phrase check, which knows only `PHRASE`. */
const phraseToEntropy = (phrase: string): Uint8Array | null => (phrase.trim() === PHRASE ? ENTROPY : null);

/** The host page, its stores reset after each story. */
const page = fakeDebugPanelHost({ walletSwitch: intents, phraseToEntropy });

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

/** A local wallet is active for this story. */
const localWallet = (): void => {
  page.walletMode.set({ mode: 'local', failure: null });
};

/** As a developer using the debug panel, I paste my phrase and use it locally, and this browser switches to the local wallet. */
export const ImportSwitchesToLocal: Story = {
  tags: ['!autodocs'],
  play: async ({ canvas, userEvent, step }) => {
    await step('Given I paste my phrase', async () => {
      await userEvent.click(canvas.getByRole('textbox', { name: 'Polkadot App recovery phrase' }));
      await userEvent.paste(PHRASE);
    });
    await step('When I use it locally', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Use locally' }));
    });
    await step('Then this browser switches to the local wallet', async () => {
      await expect(intents.useLocalWallet).toHaveBeenCalledWith(ENTROPY);
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

/** As a developer using the debug panel, I use a mistyped phrase and am told so with nothing saved. */
export const MistypedPhrase: Story = {
  tags: ['!autodocs'],
  play: async ({ canvas, userEvent, step }) => {
    await step('Given I mistyped my phrase', async () => {
      await userEvent.type(
        canvas.getByRole('textbox', { name: 'Polkadot App recovery phrase' }),
        'bottom drive obey lake',
      );
    });
    await step('When I use it locally', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Use locally' }));
    });
    await step('Then I am told and nothing is saved', async () => {
      await expect(await canvas.findByTestId('td-wallet-error')).toHaveTextContent('Not a valid recovery phrase');
      await expect(intents.useLocalWallet).not.toHaveBeenCalled();
    });
  },
};

/** As a developer using the debug panel, I use a phrase when the save fails and am told to try again and can submit again. */
export const SaveFailedRetry: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    intents.useLocalWallet.mockImplementationOnce(failed);
  },
  play: async ({ canvas, userEvent, step }) => {
    await step('Given I paste my phrase', async () => {
      await userEvent.click(canvas.getByRole('textbox', { name: 'Polkadot App recovery phrase' }));
      await userEvent.paste(PHRASE);
    });
    await step('When I use it locally and the save fails', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Use locally' }));
    });
    await step('Then I am told to try again and can submit again', async () => {
      await expect(await canvas.findByTestId('td-wallet-error')).toHaveTextContent(
        'The wallet could not be saved. Try again.',
      );
      await expect(canvas.getByRole('button', { name: 'Use locally' })).toBeEnabled();
    });
  },
};

/** As a developer using the debug panel, I forget my local wallet and this browser goes back to Polkadot App. */
export const LocalAccountForget: Story = {
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
    await step('When I forget the wallet', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Forget' }));
    });
    await step('Then this browser goes back to Polkadot App', async () => {
      await expect(intents.usePolkadotApp).toHaveBeenCalledTimes(1);
    });
  },
};

/** As a developer using the debug panel, I forget my wallet when the switch fails and am told to try again. */
export const ForgetFailed: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    localWallet();
    intents.usePolkadotApp.mockImplementationOnce(failed);
  },
  play: async ({ canvas, userEvent, step }) => {
    await step('When I forget the wallet and the switch fails', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Forget' }));
    });
    await step('Then I am told to try again', async () => {
      await expect(await canvas.findByRole('alert')).toHaveTextContent('Could not switch back. Try again.');
      await expect(canvas.getByRole('button', { name: 'Forget' })).toBeEnabled();
    });
  },
};

/** As a developer using the debug panel, I replace my wallet with another phrase and the new phrase is used instead of Polkadot App. */
export const ReplacePhrase: Story = {
  tags: ['!autodocs'],
  beforeEach: localWallet,
  play: async ({ canvas, userEvent, step }) => {
    await step('Given I start replacing my wallet and paste another phrase', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Replace' }));
      await userEvent.click(canvas.getByRole('textbox', { name: 'Polkadot App recovery phrase' }));
      await userEvent.paste(PHRASE);
    });
    await step('When I replace it', async () => {
      await userEvent.click(canvas.getByTestId('td-wallet-use-local'));
    });
    await step('Then the new phrase is used and Polkadot App is not', async () => {
      await expect(canvas.getByTestId('td-wallet-use-local')).toHaveTextContent('Replace');
      await expect(intents.useLocalWallet).toHaveBeenCalledWith(ENTROPY);
      await expect(intents.usePolkadotApp).not.toHaveBeenCalled();
    });
  },
};

/** As a developer using the debug panel, I cancel replacing my wallet and keep it. */
export const CancelReplace: Story = {
  tags: ['!autodocs'],
  beforeEach: localWallet,
  play: async ({ canvas, userEvent, step }) => {
    await step('Given I start replacing my wallet', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Replace' }));
    });
    await step('When I cancel', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
    });
    await step('Then I keep my wallet', async () => {
      await expect(canvas.queryByRole('textbox', { name: 'Polkadot App recovery phrase' })).toBeNull();
      await expect(canvas.getByTestId('td-wallet-account')).toHaveTextContent('Activating');
      await expect(intents.useLocalWallet).not.toHaveBeenCalled();
    });
  },
};

/** As a developer using the debug panel, I see the import form has no Cancel, since there is no wallet to keep. */
export const ImportHasNoCancel: Story = {
  play: async ({ canvas, step }) => {
    await step('Then the import form has no Cancel', async () => {
      await expect(canvas.getByRole('button', { name: 'Use locally' })).toBeVisible();
      await expect(canvas.queryByRole('button', { name: 'Cancel' })).toBeNull();
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
