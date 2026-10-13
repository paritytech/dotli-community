// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { Button, ModalFocusFallback, openModal, type ModalOutcome, type ModalView } from '@dotli/ui';
import { resetModalsForTests } from '@dotli/ui/testing';
import { ModalOutlet } from './ModalOutlet.js';

type Choice = 'deny' | 'allow' | 'once' | 'dismissed';

const permissionLike = (overrides: Partial<ModalView<Choice>> = {}): ModalView<Choice> => ({
  title: 'Permission Request',
  fields: [{ label: 'Application', value: 'playground.dot' }],
  notice: 'Granting this permission will reload the application.',
  buttons: [
    { label: 'Deny', variant: 'danger', result: 'deny' },
    { label: 'Always allow', variant: 'secondary', result: 'allow' },
    { label: 'Allow once', variant: 'primary', result: 'once' },
  ],
  dismissOnBackdrop: true,
  dismissResult: 'dismissed',
  ...overrides,
});

const passwordView: ModalView<'cancel' | 'unlock'> = {
  title: 'Encrypted Content',
  fields: [],
  input: { kind: 'password', placeholder: 'Password', hint: 'Enter the password to decrypt.' },
  buttons: [
    { label: 'Cancel', variant: 'cancel', result: 'cancel' },
    { label: 'Unlock', variant: 'primary', result: 'unlock' },
  ],
  dismissOnBackdrop: false,
};

/** What the story asks each time I press the page's Ask button, and every outcome it got back, in order. */
const asked: { views: ModalView<string>[]; outcomes: Promise<ModalOutcome<string>>[] } = { views: [], outcomes: [] };
/** The app frame the page hands focus to, as the host page gives its product frame. */
let appFrame: HTMLIFrameElement | undefined;
const ask =
  (...views: ModalView<string>[]) =>
  () => {
    resetModalsForTests();
    appFrame = undefined;
    asked.views = views;
    asked.outcomes = [];
    return () => {
      resetModalsForTests();
      appFrame = undefined;
    };
  };

/** The page: the Ask button that queues the story's prompts, the app's frames when given, and the outlet. */
function Page(props: { frames?: number }) {
  return (
    <div style={{ display: 'flex', gap: '8px', 'flex-direction': 'column', 'align-items': 'flex-start' }}>
      <Button
        testId="opener"
        onClick={() => {
          asked.outcomes.push(...asked.views.map(view => openModal(view)));
        }}
      >
        Ask
      </Button>
      <Show when={props.frames}>
        {count => (
          <div id="app" style={{ display: 'flex', gap: '8px' }}>
            {Array.from({ length: count() }, (_, i) => (
              <iframe
                title={`App frame ${String(i + 1)}`}
                data-testid={`frame-${String(i + 1)}`}
                srcdoc="<body style='margin:0;background:#335'></body>"
                style={{ width: '120px', height: '60px', border: '0' }}
              />
            ))}
          </div>
        )}
      </Show>
      <ModalFocusFallback value={() => appFrame}>
        <ModalOutlet />
      </ModalFocusFallback>
    </div>
  );
}

const meta = {
  title: 'Overlays/ModalOutlet',
  component: Page,
  parameters: { chrome: true, docs: { story: { inline: false, height: '640px' } } },
  tags: ['!autodocs'],
} satisfies Meta<typeof Page>;

export default meta;
type Story = StoryObj<typeof meta>;

// The dialog is portalled into the body, outside the story's canvas.
const body = within(document.body);
/** Trusted input, as the Tab trap and the scrim meet it. Imported lazily so Storybook loads the stories outside Vitest. */
const input = async () => (await import('vitest/browser')).userEvent;
const backdrop = () => body.queryByTestId('signing-modal-backdrop');
const title = () => body.getByRole('heading', { level: 2 }).textContent;
const press = async (el: Element) => {
  await (await input()).click(el);
};
/** A press on the scrim beside the card, as a real press there lands. */
const pressScrim = async () => {
  await (await input()).click(body.getByTestId('signing-modal-scrim'), { position: { x: 4, y: 4 } });
};
const askNow = async () => {
  await press(body.getByTestId('opener'));
  await waitFor(() => expect(backdrop()).toHaveAttribute('data-open'));
};
const closed = async () => {
  await waitFor(() => expect(backdrop()).toBeNull());
};

export const ButtonSettles: Story = {
  beforeEach: ask(permissionLike()),
  play: async ({ step }) => {
    await step('Given a prompt is up', askNow);
    await step('When I press Always allow', () => press(body.getByRole('button', { name: 'Always allow' })));
    await step("Then it settles with that button's answer and closes", async () => {
      await expect(asked.outcomes[0]).resolves.toEqual({ result: 'allow' });
      await closed();
    });
  },
};

export const PhoneLocksScroll: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  beforeEach: ask(permissionLike()),
  play: async ({ step }) => {
    await step('Given a prompt is up on a phone', askNow);
    await step('Then the page under it does not scroll', async () => {
      await expect(document.body).toHaveAttribute('data-scroll-locked');
    });
    await step('When I answer it', () => press(body.getByRole('button', { name: 'Always allow' })));
    await step('Then the page scrolls again', async () => {
      await expect(asked.outcomes[0]).resolves.toEqual({ result: 'allow' });
      await waitFor(() => expect(document.body).not.toHaveAttribute('data-scroll-locked'));
    });
  },
};

export const ScrimAndEscapeDismiss: Story = {
  beforeEach: ask(permissionLike(), permissionLike({ title: 'Second' })),
  play: async ({ step }) => {
    await step('Given two prompts are queued', askNow);
    await step('When I click inside the card, then nothing is answered', async () => {
      await press(body.getByTestId('permission-modal-notice'));
      await expect(title()).toBe('Permission Request');
    });
    await step('When I press the scrim, then the first is dismissed and the second shows', async () => {
      await pressScrim();
      await expect(asked.outcomes[0]).resolves.toEqual({ result: 'dismissed' });
      await waitFor(() => expect(title()).toBe('Second'));
    });
    await step('When I press Escape, then the second is dismissed', async () => {
      await (await input()).keyboard('{Escape}');
      await expect(asked.outcomes[1]).resolves.toEqual({ result: 'dismissed' });
      await closed();
    });
  },
};

export const EscapeHandledForPage: Story = {
  beforeEach: ask(permissionLike()),
  play: async ({ step }) => {
    const seen: boolean[] = [];
    const listener = (event: KeyboardEvent): void => {
      seen.push(event.defaultPrevented);
    };
    await step('Given a prompt is up and the page listens for keys', async () => {
      await askNow();
      document.addEventListener('keydown', listener);
    });
    await step('When I press Escape', async () => {
      await (await input()).keyboard('{Escape}');
    });
    await step('Then the prompt closed and the page heard the key as handled', async () => {
      await closed();
      document.removeEventListener('keydown', listener);
      await expect(seen).toEqual([true]);
    });
  },
};

export const MustAnswerIgnoresScrimAndEscape: Story = {
  beforeEach: ask(passwordView),
  play: async ({ step }) => {
    let settled = false;
    await step('Given a password prompt is up', async () => {
      await askNow();
      void asked.outcomes[0]?.then(() => {
        settled = true;
      });
    });
    await step('When I press the scrim and Escape', async () => {
      await pressScrim();
      await (await input()).keyboard('{Escape}');
    });
    await step('Then it is still up and unanswered', async () => {
      await new Promise(resolve => requestAnimationFrame(resolve));
      await expect(settled).toBe(false);
      await expect(backdrop()).toHaveAttribute('data-open');
    });
  },
};

export const PhoneSheetCloseDismisses: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  beforeEach: ask(permissionLike()),
  play: async ({ step }) => {
    await step('Given a prompt is up on a phone', askNow);
    await step("When I press the sheet's Close", async () => {
      await press(await body.findByTestId('signing-modal-sheet-close'));
    });
    await step('Then it is dismissed as the scrim would, and closes', async () => {
      await expect(asked.outcomes[0]).resolves.toEqual({ result: 'dismissed' });
      await closed();
    });
  },
};

export const PhoneSheetCloseCancels: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  beforeEach: ask(passwordView),
  play: async ({ step }) => {
    await step('Given a password prompt is up on a phone and I typed', async () => {
      await askNow();
      await (await input()).type(body.getByTestId('password-prompt-input'), 'typed');
    });
    await step("When I press the sheet's Close", async () => {
      await press(await body.findByTestId('signing-modal-sheet-close'));
    });
    await step('Then it answers Cancel, without what I typed', async () => {
      await expect(asked.outcomes[0]).resolves.toEqual({ result: 'cancel' });
    });
  },
};

export const FocusReturnsToOpener: Story = {
  beforeEach: ask(permissionLike()),
  play: async ({ step }) => {
    await step('Given I asked from the page', askNow);
    await step('When I answer', () => press(body.getByRole('button', { name: 'Deny' })));
    await step('Then focus is back where I was', async () => {
      await closed();
      await expect(body.getByTestId('opener')).toHaveFocus();
    });
  },
};

export const PasswordEnterSubmits: Story = {
  beforeEach: ask({ ...passwordView, input: { kind: 'password', placeholder: 'Password', error: 'Wrong password' } }),
  play: async ({ step }) => {
    const field = () => body.getByTestId('password-prompt-input');
    await step('Given the password prompt is up with focus in its field', async () => {
      await askNow();
      await waitFor(() => expect(field()).toHaveFocus());
      await expect(body.getByRole('alert')).toHaveTextContent('Wrong password');
    });
    await step('When I press Enter with nothing typed, then nothing is sent', async () => {
      await (await input()).keyboard('{Enter}');
      await expect(backdrop()).toHaveAttribute('data-open');
      await expect(body.getByRole('button', { name: 'Unlock' })).toBeDisabled();
    });
    await step('When I type the password and press Enter', async () => {
      await (await input()).type(field(), 'hunter2');
      await expect(body.getByRole('button', { name: 'Unlock' })).toBeEnabled();
      await (await input()).keyboard('{Enter}');
    });
    await step('Then it unlocks with what I typed, and the Enter does not ask again from the page', async () => {
      await expect(asked.outcomes).toHaveLength(1);
      await expect(asked.outcomes[0]).resolves.toEqual({ result: 'unlock', value: 'hunter2' });
      await closed();
      await expect(body.getByTestId('opener')).toHaveFocus();
    });
  },
};

export const PasswordCancelDropsText: Story = {
  beforeEach: ask(passwordView),
  play: async ({ step }) => {
    await step('Given I typed in the password prompt', async () => {
      await askNow();
      await (await input()).type(body.getByTestId('password-prompt-input'), 'typed');
    });
    await step('When I press Cancel', () => press(body.getByRole('button', { name: 'Cancel' })));
    await step('Then it settles without the typed value', async () => {
      await expect(asked.outcomes[0]).resolves.toEqual({ result: 'cancel' });
    });
  },
};

export const QueuedDialogGetsFocus: Story = {
  beforeEach: ask(permissionLike(), permissionLike({ title: 'Second' })),
  play: async ({ step }) => {
    await step('Given two prompts are queued', askNow);
    await step('When I answer the first', () => press(body.getByRole('button', { name: 'Deny' })));
    await step('Then the second shows with focus on it', async () => {
      await waitFor(() => expect(title()).toBe('Second'));
      await waitFor(() => expect(body.getByTestId('signing-modal')).toHaveFocus());
    });
  },
};

export const FocusReturnsAfterQueue: Story = {
  beforeEach: ask(permissionLike(), permissionLike({ title: 'Second' })),
  play: async ({ step }) => {
    await step('Given two prompts are queued from the page', askNow);
    await step('When I answer both', async () => {
      await press(body.getByRole('button', { name: 'Deny' }));
      await waitFor(() => expect(title()).toBe('Second'));
      await press(body.getByRole('button', { name: 'Deny' }));
    });
    await step('Then focus is back where I was', async () => {
      await closed();
      await expect(body.getByTestId('opener')).toHaveFocus();
    });
  },
};

export const GoneOriginFocusesApp: Story = {
  args: { frames: 1 },
  beforeEach: ask(permissionLike()),
  play: async ({ step }) => {
    await step('Given a prompt is up over the app, and the button I came from leaves the page', async () => {
      await askNow();
      appFrame = body.getByTestId<HTMLIFrameElement>('frame-1');
      body.getByTestId('opener').remove();
    });
    await step('When I answer', () => press(body.getByRole('button', { name: 'Deny' })));
    await step('Then focus goes to the app, not the page', async () => {
      await closed();
      await expect(document.activeElement).toBe(body.getByTestId('frame-1'));
    });
  },
};

export const ReloadFocusesNewFrame: Story = {
  args: { frames: 2 },
  beforeEach: ask(permissionLike()),
  play: async ({ step }) => {
    await step('Given an app reload swapped the frame while the prompt is up, and my button is gone', async () => {
      appFrame = body.getByTestId<HTMLIFrameElement>('frame-1');
      await askNow();
      appFrame = body.getByTestId<HTMLIFrameElement>('frame-2');
      body.getByTestId('opener').remove();
    });
    await step('When I answer', () => press(body.getByRole('button', { name: 'Deny' })));
    await step("Then focus goes to the app's new frame", async () => {
      await closed();
      await expect(document.activeElement).toBe(body.getByTestId('frame-2'));
    });
  },
};

export const SecondOpensOverScrim: Story = {
  beforeEach: ask(permissionLike(), permissionLike({ title: 'Second' })),
  play: async ({ step }) => {
    await step('Given two prompts are queued, the first bringing its scrim in', async () => {
      await askNow();
      await expect(backdrop()).not.toHaveAttribute('data-follows');
    });
    await step('When I answer the first', () => press(body.getByRole('button', { name: 'Deny' })));
    await step('Then the second opens over the scrim that is already up', async () => {
      await waitFor(() => expect(title()).toBe('Second'));
      await expect(backdrop()).toHaveAttribute('data-follows');
    });
  },
};

export const ScrimDenyKeepsScrim: Story = {
  beforeEach: ask(permissionLike(), permissionLike({ title: 'Second' })),
  play: async ({ step }) => {
    await step('Given two prompts are queued', askNow);
    await step('When I dismiss the first with a scrim press', pressScrim);
    await step('Then the second opens over the same scrim', async () => {
      await waitFor(() => expect(title()).toBe('Second'));
      await expect(backdrop()).toHaveAttribute('data-follows');
    });
  },
};

export const ScrimHandOffReturnsFocus: Story = {
  beforeEach: ask(permissionLike(), permissionLike({ title: 'Second' })),
  play: async ({ step }) => {
    await step('Given two prompts are queued from the page', askNow);
    await step('When a scrim press dismisses the first and I answer the second', async () => {
      await pressScrim();
      await waitFor(() => expect(title()).toBe('Second'));
      await press(body.getByRole('button', { name: 'Deny' }));
    });
    await step('Then focus is back where I was', async () => {
      await closed();
      await expect(body.getByTestId('opener')).toHaveFocus();
    });
  },
};

export const LaterPromptBringsScrim: Story = {
  beforeEach: ask(permissionLike({ title: 'Later' })),
  play: async ({ step }) => {
    await step('Given a prompt came and was answered', async () => {
      await askNow();
      await press(body.getByRole('button', { name: 'Deny' }));
      await closed();
    });
    await step('When another prompt opens after the queue emptied', askNow);
    await step('Then it brings its own scrim in', async () => {
      await expect(title()).toBe('Later');
      await expect(backdrop()).not.toHaveAttribute('data-follows');
    });
  },
};
