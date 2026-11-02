// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { trustedInput } from '@config/storybook/play';
import { appears } from '@dotli/ui/testing';
import { Button } from '../../components/primitives/Button.js';
import { ModalFocusFallback } from '../../components/floating/layerContext.js';
import { modals, type ModalHandoff, type ModalOutcome, type ModalView } from '../../page/state/createModals.js';
import { ModalOutlet } from './ModalOutlet.js';

type Choice = 'deny' | 'allow' | 'once' | 'dismissed';

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
const asked: {
  views: ModalView<string>[];
  outcomes: Promise<ModalOutcome<string>>[];
  /** What an answered dialog hands its place to, when a story needs it. */
  next?: ModalView<string> | undefined;
} = { views: [], outcomes: [] };
/** How the handed-off view closed, for the handoff stories. */
const handoffClosed: string[] = [];
/** The app frame the page hands focus to, as the host page gives its product frame. */
let appFrame: HTMLIFrameElement | undefined;
// The dialog is portalled into the body, outside the story's canvas.
const body = within(document.body);

const meta = {
  title: 'Overlays/ModalOutlet',
  component: Page,
  parameters: { chrome: true, docs: { story: { inline: false, height: '640px' } } },
  tags: ['!autodocs'],
} satisfies Meta<typeof Page>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a dotli user, I press Always allow on a prompt and it settles with that answer and closes. */
export const ButtonSettles: Story = {
  beforeEach: ask(buildPermissionView()),
  play: async ({ step }) => {
    await step('Given a prompt is up', askNow);
    await step('When I press Always allow', () => press(body.getByRole('button', { name: 'Always allow' })));
    await step("Then it settles with that button's answer and closes", async () => {
      await expect(asked.outcomes[0]).resolves.toEqual({ result: 'allow' });
      await waitForClosed();
    });
  },
};

/** As a phone user, I cannot scroll the page under a prompt until I answer it. */
export const PhoneLocksScroll: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  beforeEach: ask(buildPermissionView()),
  play: async ({ step }) => {
    await step('When a prompt comes up on a phone', askNow);
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

/** As a dotli user, I dismiss queued prompts with the scrim and Escape one by one, and a click inside the card answers nothing. */
export const ScrimAndEscapeDismiss: Story = {
  beforeEach: ask(buildPermissionView(), buildPermissionView({ title: 'Second' })),
  play: async ({ step }) => {
    await step('Given two prompts are queued', askNow);
    await step('When I click inside the card', () => press(body.getByTestId('prompt-dialog-notice')));
    await step('Then nothing is answered', async () => {
      await expect(readTitle()).toBe('Permission Request');
    });
    await step('When I press the scrim', pressScrim);
    await step('Then the first is dismissed and the second shows', async () => {
      await expect(asked.outcomes[0]).resolves.toEqual({ result: 'dismissed' });
      await waitFor(() => expect(readTitle()).toBe('Second'));
    });
    await step('When I press Escape', async () => {
      await (await trustedInput()).keyboard('{Escape}');
    });
    await step('Then the second is dismissed', async () => {
      await expect(asked.outcomes[1]).resolves.toEqual({ result: 'dismissed' });
      await waitForClosed();
    });
  },
};

/** As a dotli user, I press Escape on a prompt and it closes while the page hears the key as handled. */
export const EscapeHandledForPage: Story = {
  beforeEach: ask(buildPermissionView()),
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
      await (await trustedInput()).keyboard('{Escape}');
      document.removeEventListener('keydown', listener);
    });
    await step('Then the prompt closed and the page heard the key as handled', async () => {
      await waitForClosed();
      await expect(seen).toEqual([true]);
    });
  },
};

/** As a dotli user, I press the scrim and Escape on a password prompt and it stays up, so the only answer it gives is mine. */
export const MustAnswerIgnoresScrimAndEscape: Story = {
  beforeEach: ask(passwordView),
  play: async ({ step }) => {
    await step('Given a password prompt is up', askNow);
    await step('When I press the scrim and Escape', async () => {
      await pressScrim();
      await (await trustedInput()).keyboard('{Escape}');
    });
    await step('Then it is still up', async () => {
      await expect(queryBackdrop()).toHaveAttribute('data-open');
    });
    await step('When I type the password and press Unlock', async () => {
      await (await trustedInput()).type(body.getByTestId('prompt-dialog-input'), 'hunter2');
      await press(body.getByRole('button', { name: 'Unlock' }));
    });
    await step('Then its only answer is Unlock, so the scrim and Escape answered nothing', async () => {
      await expect(asked.outcomes[0]).resolves.toEqual({ result: 'unlock', value: 'hunter2' });
      await waitForClosed();
    });
  },
};

/** As a phone user, I press Close on a prompt sheet and it is dismissed as the scrim would. */
export const PhoneSheetCloseDismisses: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  beforeEach: ask(buildPermissionView()),
  play: async ({ step }) => {
    await step('Given a prompt is up on a phone', askNow);
    await step("When I press the sheet's Close", async () => {
      await press(await body.findByTestId('prompt-dialog-sheet-close'));
    });
    await step('Then it is dismissed as the scrim would, and closes', async () => {
      await expect(asked.outcomes[0]).resolves.toEqual({ result: 'dismissed' });
      await waitForClosed();
    });
  },
};

/** As a phone user, I press Close on a password sheet and it answers Cancel without what I typed. */
export const PhoneSheetCloseCancels: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  beforeEach: ask(passwordView),
  play: async ({ step }) => {
    await step('Given a password prompt is up on a phone and I typed', async () => {
      await askNow();
      await (await trustedInput()).type(body.getByTestId('prompt-dialog-input'), 'typed');
    });
    await step("When I press the sheet's Close", async () => {
      await press(await body.findByTestId('prompt-dialog-sheet-close'));
    });
    await step('Then it answers Cancel, without what I typed', async () => {
      await expect(asked.outcomes[0]).resolves.toEqual({ result: 'cancel' });
    });
  },
};

/** As a keyboard user, I answer a prompt and focus returns to where I was. */
export const FocusReturnsToOpener: Story = {
  beforeEach: ask(buildPermissionView()),
  play: async ({ step }) => {
    await step('Given I asked from the page', askNow);
    await step('When I answer', () => press(body.getByRole('button', { name: 'Deny' })));
    await step('Then focus is back where I was', async () => {
      await waitForClosed();
      await expect(body.getByTestId('opener')).toHaveFocus();
    });
  },
};

/** As a dotli user, I press Enter in the password field and it unlocks with what I typed, but sends nothing when the field is empty. */
export const PasswordEnterSubmits: Story = {
  beforeEach: ask({ ...passwordView, input: { kind: 'password', placeholder: 'Password', error: 'Wrong password' } }),
  play: async ({ step }) => {
    const field = () => body.getByTestId('prompt-dialog-input');
    await step('When the password prompt comes up', askNow);
    await step('Then focus is in its field and its error shows', async () => {
      await waitFor(() => expect(field()).toHaveFocus());
      await expect(body.getByRole('alert')).toHaveTextContent('Wrong password');
    });
    await step('When I press Enter with nothing typed', async () => {
      await (await trustedInput()).keyboard('{Enter}');
    });
    await step('Then nothing is sent', async () => {
      await expect(queryBackdrop()).toHaveAttribute('data-open');
      await expect(body.getByRole('button', { name: 'Unlock' })).toBeDisabled();
    });
    await step('When I type the password', async () => {
      await (await trustedInput()).type(field(), 'hunter2');
    });
    await step('Then Unlock is ready', async () => {
      await expect(body.getByRole('button', { name: 'Unlock' })).toBeEnabled();
    });
    await step('When I press Enter', async () => {
      await (await trustedInput()).keyboard('{Enter}');
    });
    await step('Then it unlocks with what I typed, and the Enter does not ask again from the page', async () => {
      await expect(asked.outcomes).toHaveLength(1);
      await expect(asked.outcomes[0]).resolves.toEqual({ result: 'unlock', value: 'hunter2' });
      await waitForClosed();
      await expect(body.getByTestId('opener')).toHaveFocus();
    });
  },
};

/** As a dotli user, I cancel a password prompt and it settles without what I typed. */
export const PasswordCancelDropsText: Story = {
  beforeEach: ask(passwordView),
  play: async ({ step }) => {
    await step('Given I typed in the password prompt', async () => {
      await askNow();
      await (await trustedInput()).type(body.getByTestId('prompt-dialog-input'), 'typed');
    });
    await step('When I press Cancel', () => press(body.getByRole('button', { name: 'Cancel' })));
    await step('Then it settles without the typed value', async () => {
      await expect(asked.outcomes[0]).resolves.toEqual({ result: 'cancel' });
    });
  },
};

/** As a keyboard user, I answer the first of two prompts and the second shows with focus on it. */
export const QueuedDialogGetsFocus: Story = {
  beforeEach: ask(buildPermissionView(), buildPermissionView({ title: 'Second' })),
  play: async ({ step }) => {
    await step('Given two prompts are queued', askNow);
    await step('When I answer the first', () => press(body.getByRole('button', { name: 'Deny' })));
    await step('Then the second shows with focus on it', async () => {
      await waitFor(() => expect(readTitle()).toBe('Second'));
      await waitFor(() => expect(body.getByTestId('prompt-dialog')).toHaveFocus());
    });
  },
};

/** As a keyboard user, I answer two queued prompts and focus returns to where I was. */
export const FocusReturnsAfterQueue: Story = {
  beforeEach: ask(buildPermissionView(), buildPermissionView({ title: 'Second' })),
  play: async ({ step }) => {
    await step('Given two prompts are queued from the page', askNow);
    await step('When I answer the first', () => press(body.getByRole('button', { name: 'Deny' })));
    await step('Then the second shows', async () => {
      await waitFor(() => expect(readTitle()).toBe('Second'));
    });
    await step('When I answer the second', () => press(body.getByRole('button', { name: 'Deny' })));
    await step('Then focus is back where I was', async () => {
      await waitForClosed();
      await expect(body.getByTestId('opener')).toHaveFocus();
    });
  },
};

/** As a keyboard user, I answer a prompt after the button I came from left the page and focus goes to the app. */
export const GoneOriginFocusesApp: Story = {
  args: { frames: 1 },
  beforeEach: ask(buildPermissionView()),
  play: async ({ step }) => {
    await step('Given a prompt is up over the app, and the button I came from leaves the page', async () => {
      await askNow();
      appFrame = body.getByTestId<HTMLIFrameElement>('frame-1');
      body.getByTestId('opener').remove();
    });
    await step('When I answer', () => press(body.getByRole('button', { name: 'Deny' })));
    await step('Then focus goes to the app, not the page', async () => {
      await waitForClosed();
      await expect(document.activeElement).toBe(body.getByTestId('frame-1'));
    });
  },
};

/** As a keyboard user, I answer a prompt after the app reloaded and focus goes to the app's new frame. */
export const ReloadFocusesNewFrame: Story = {
  args: { frames: 2 },
  beforeEach: ask(buildPermissionView()),
  play: async ({ step }) => {
    await step('Given an app reload swapped the frame while the prompt is up, and my button is gone', async () => {
      appFrame = body.getByTestId<HTMLIFrameElement>('frame-1');
      await askNow();
      appFrame = body.getByTestId<HTMLIFrameElement>('frame-2');
      body.getByTestId('opener').remove();
    });
    await step('When I answer', () => press(body.getByRole('button', { name: 'Deny' })));
    await step("Then focus goes to the app's new frame", async () => {
      await waitForClosed();
      await expect(document.activeElement).toBe(body.getByTestId('frame-2'));
    });
  },
};

/** As a dotli user, I answer the first of two prompts and the second opens over the scrim already up. */
export const SecondOpensOverScrim: Story = {
  beforeEach: ask(buildPermissionView(), buildPermissionView({ title: 'Second' })),
  play: async ({ step }) => {
    await step('When two prompts are queued', askNow);
    await step('Then the first brings its scrim in', async () => {
      await expect(queryBackdrop()).not.toHaveAttribute('data-follows');
    });
    await step('When I answer the first', () => press(body.getByRole('button', { name: 'Deny' })));
    await step('Then the second opens over the scrim that is already up', async () => {
      await waitFor(() => expect(readTitle()).toBe('Second'));
      await expect(queryBackdrop()).toHaveAttribute('data-follows');
    });
  },
};

/** As a dotli user, I dismiss the first prompt with the scrim and the second opens over the same scrim. */
export const ScrimDenyKeepsScrim: Story = {
  beforeEach: ask(buildPermissionView(), buildPermissionView({ title: 'Second' })),
  play: async ({ step }) => {
    await step('Given two prompts are queued', askNow);
    await step('When I dismiss the first with a scrim press', pressScrim);
    await step('Then the second opens over the same scrim', async () => {
      await waitFor(() => expect(readTitle()).toBe('Second'));
      await expect(queryBackdrop()).toHaveAttribute('data-follows');
    });
  },
};

/** As a keyboard user, I dismiss one prompt with the scrim and answer the next and focus returns to where I was. */
export const ScrimHandOffReturnsFocus: Story = {
  beforeEach: ask(buildPermissionView(), buildPermissionView({ title: 'Second' })),
  play: async ({ step }) => {
    await step('Given two prompts are queued from the page', askNow);
    await step('When a scrim press dismisses the first', pressScrim);
    await step('Then the second shows', async () => {
      await waitFor(() => expect(readTitle()).toBe('Second'));
    });
    await step('When I answer the second', () => press(body.getByRole('button', { name: 'Deny' })));
    await step('Then focus is back where I was', async () => {
      await waitForClosed();
      await expect(body.getByTestId('opener')).toHaveFocus();
    });
  },
};

/** As a dotli user, I get a later prompt after the queue emptied and it brings its own scrim in. */
export const LaterPromptBringsScrim: Story = {
  beforeEach: ask(buildPermissionView({ title: 'Later' })),
  play: async ({ step }) => {
    await step('Given a prompt came and was answered', async () => {
      await askNow();
      await press(body.getByRole('button', { name: 'Deny' }));
      await waitForClosed();
    });
    await step('When another prompt opens after the queue emptied', askNow);
    await step('Then it brings its own scrim in', async () => {
      await expect(readTitle()).toBe('Later');
      await expect(queryBackdrop()).not.toHaveAttribute('data-follows');
    });
  },
};

/** As a dotli user, I answer a review and the same dialog shows the next step in place. */
export const HandoffSwapsInPlace: Story = {
  beforeEach: askWithHandoff(buildReviewWithSign(), buildWaitingView()),
  play: async ({ step }) => {
    let dialog: HTMLElement | undefined;
    await step('Given a review is up', async () => {
      await askNow();
      dialog = body.getByTestId('prompt-dialog');
    });
    await step('When I press Sign', () => press(body.getByRole('button', { name: 'Sign' })));
    await step('Then the same dialog shows the next step and the review fields are gone', async () => {
      await waitFor(() => expect(body.getByText('Waiting step body')).toBeVisible());
      await expect(body.getByTestId('prompt-dialog')).toBe(dialog);
      await expect(body.queryByTestId('prompt-dialog-field')).toBeNull();
      await expect(asked.outcomes[0]).resolves.toEqual({ result: 'once' });
    });
    await step('And focus is on the dialog itself, not lost to the page or put on its button', async () => {
      await waitFor(() => expect(body.getByTestId('prompt-dialog')).toHaveFocus());
    });
    await step('And the focused dialog is described by the next step, so a screen reader reads it', async () => {
      await expect(body.getByTestId('prompt-dialog')).toHaveAccessibleDescription(
        expect.stringContaining('Waiting step body'),
      );
    });
    await step('When I press Enter right after the swap, as a repeated key would', async () => {
      await (await trustedInput()).keyboard('{Enter}');
    });
    await step('Then the next step is still up and nothing closed it', async () => {
      await expect(body.getByText('Waiting step body')).toBeVisible();
      await expect(handoffClosed).toEqual([]);
    });
  },
};

/** As a dotli user, I unlock a password prompt that hands its place to another and the next one starts empty. */
export const HandoffClearsPassword: Story = {
  beforeEach: askWithHandoff(passwordView, { ...passwordView, title: 'Try Again' }),
  play: async ({ step }) => {
    const field = () => body.getByTestId<HTMLInputElement>('prompt-dialog-input');
    await step('Given I typed in a password prompt', async () => {
      await askNow();
      await (await trustedInput()).type(field(), 'hunter2');
    });
    await step('When I press Unlock', () => press(body.getByRole('button', { name: 'Unlock' })));
    await step(
      'Then the next prompt takes its place, the first got what I typed, and the next starts empty',
      async () => {
        await waitFor(() => expect(readTitle()).toBe('Try Again'));
        await expect(asked.outcomes[0]).resolves.toEqual({ result: 'unlock', value: 'hunter2' });
        await expect(field()).toHaveValue('');
        await expect(body.getByRole('button', { name: 'Unlock' })).toBeDisabled();
      },
    );
  },
};

/** As a dotli user, I press Escape on the next step and it closes as the view's dismiss answer. */
export const HandoffBackgroundsOnEscape: Story = {
  beforeEach: askWithHandoff(buildReviewWithSign(), buildWaitingView()),
  play: async ({ step }) => {
    await step('Given a review is up', askNow);
    await step('When I sign', () => press(body.getByRole('button', { name: 'Sign' })));
    await step('Then the next step is up', async () => {
      await waitFor(() => expect(body.getByText('Waiting step body')).toBeVisible());
    });
    await step('When I press Escape', async () => {
      await (await trustedInput()).keyboard('{Escape}');
    });
    await step("Then the dialog is gone and the caller heard the view's dismiss answer", async () => {
      await waitForClosed();
      await expect(handoffClosed).toEqual(['background']);
    });
  },
};

/** As a phone user, I see the next step's sheet without a close button when it cannot be closed that way. */
export const HandoffSheetHasNoClose: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  beforeEach: askWithHandoff(buildReviewWithSign(), buildWaitingView({ closable: false })),
  play: async ({ step }) => {
    await step('Given a review is up on a phone, with a close button', async () => {
      await askNow();
      await body.findByTestId('prompt-dialog-sheet-close');
    });
    await step('When I press Sign', () => press(body.getByRole('button', { name: 'Sign' })));
    await step('Then the next step shows and the sheet has no close button', async () => {
      await waitFor(() => expect(body.getByText('Waiting step body')).toBeVisible());
      await expect(body.queryByTestId('prompt-dialog-sheet-close')).toBeNull();
    });
  },
};

/** The page: the Ask button that queues the story's prompts, the app's frames when given, and the outlet. */
function Page(props: { frames?: number }) {
  return (
    <div style={{ display: 'flex', gap: '8px', 'flex-direction': 'column', 'align-items': 'flex-start' }}>
      <Button
        testId="opener"
        onClick={() => {
          const { next } = asked;
          const handoff =
            next === undefined
              ? undefined
              : (): ModalHandoff => ({
                  view: next,
                  signal: new AbortController().signal,
                  closed: result => {
                    handoffClosed.push(result);
                  },
                });
          asked.outcomes.push(...asked.views.map(view => modals.open(view, { handoff })));
        }}
      >
        Ask
      </Button>
      <Show when={props.frames}>
        {count => (
          <div id="app" style={{ display: 'flex', gap: '8px' }}>
            {Array.from({ length: count() }, (_, index) => (
              <iframe
                title={`App frame ${String(index + 1)}`}
                data-testid={`frame-${String(index + 1)}`}
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

function buildPermissionView(overrides: Partial<ModalView<Choice>> = {}): ModalView<Choice> {
  return {
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
  };
}

/** The view an answered dialog hands its place to. */
function buildWaitingView(overrides: Partial<ModalView<string>> = {}): ModalView<string> {
  return {
    title: 'Waiting',
    fields: [],
    body: () => <p>Waiting step body</p>,
    buttons: [{ label: 'Wait in background', variant: 'secondary', result: 'background' }],
    dismissOnBackdrop: true,
    dismissResult: 'background',
    ...overrides,
  };
}

function buildReviewWithSign(): ModalView<Choice> {
  return buildPermissionView({
    title: 'Sign',
    buttons: [
      { label: 'Reject', variant: 'danger', result: 'deny' },
      { label: 'Sign', variant: 'primary', result: 'once' },
    ],
  });
}

function arrange(views: ModalView<string>[], next?: ModalView<string>): () => void {
  resetAllStoresForTests();
  appFrame = undefined;
  handoffClosed.length = 0;
  asked.views = views;
  asked.next = next;
  asked.outcomes = [];
  return restore;

  function restore(): void {
    asked.next = undefined;
    resetAllStoresForTests();
    appFrame = undefined;
  }
}

function ask(...views: ModalView<string>[]): () => () => void {
  return () => arrange(views);
}

/** Asks `view`, which hands its place to `next` once answered. */
function askWithHandoff(view: ModalView<string>, next: ModalView<string>): () => () => void {
  return () => arrange([view], next);
}

function queryBackdrop(): HTMLElement | null {
  return body.queryByTestId('prompt-dialog-backdrop');
}

function readTitle(): string {
  return body.getByRole('heading', { level: 2 }).textContent;
}

async function press(element: Element): Promise<void> {
  await (await trustedInput()).click(element);
}

/** A press on the scrim beside the card, as a real press there lands. */
async function pressScrim(): Promise<void> {
  await (await trustedInput()).click(body.getByTestId('prompt-dialog-scrim'), { position: { x: 4, y: 4 } });
}

async function askNow(): Promise<void> {
  await press(body.getByTestId('opener'));
  await appears('[data-testid="prompt-dialog-backdrop"][data-open]');
}

async function waitForClosed(): Promise<void> {
  await waitFor(() => expect(queryBackdrop()).toBeNull());
}
