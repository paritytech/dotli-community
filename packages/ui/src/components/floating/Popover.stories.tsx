// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, lazy } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { trustedInput } from '@config/storybook/play';
import { appears } from '@dotli/ui/testing';
import { Button } from '../primitives/Button.js';
import { Popover } from './Popover.js';

type Held = 'a' | 'b' | undefined;

const onOpenChange = fn().mockName('onOpenChange');
const onElse = fn().mockName('onElse');
// The surface is portalled into the body, outside the story's canvas.
const body = within(document.body);
// Which button the popover holds, set by the play as a session drop or a re-render would.
const [held, setHeld] = createSignal<Held>('a');

const Failing = lazy(() => Promise.reject(new Error('chunk')));

/** Contents for the focus stories, each the case a surface's Tab order must get right in a real browser. */
const CONTENTS = {
  buttons: () => (
    <div style={{ padding: '12px', display: 'flex', gap: '8px' }}>
      <Button testId="inside-a">A</Button>
      <Button testId="inside-b">B</Button>
    </div>
  ),
  failing: () => <Failing />,
  // Disabled controls and a link without href take no focus, and Tab reaches only the checked radio of a group.
  radios: () => (
    <div style={{ padding: '12px', display: 'flex', gap: '8px', 'align-items': 'center' }}>
      <Button disabled testId="inside-disabled">
        Off
      </Button>
      <a data-testid="inside-no-href">No link</a>
      <Button testId="inside-a">A</Button>
      <label>
        <input type="radio" name="story-radios" checked data-testid="radio-on" /> On
      </label>
      <label>
        <input type="radio" name="story-radios" data-testid="radio-off" /> Off
      </label>
    </div>
  ),
  // Buttons out of the Tab order around the two stops, as a segmented control's unpressed options are.
  'tab-order': () => (
    <div style={{ padding: '12px', display: 'flex', gap: '8px' }}>
      <button type="button" tabindex="-1" data-testid="a-ask">
        Ask
      </button>
      <button type="button" tabindex="0" data-testid="a-allow">
        Allow
      </button>
      <button type="button" tabindex="0" data-testid="b-ask">
        Ask
      </button>
      <button type="button" tabindex="-1" data-testid="b-allow">
        Allow
      </button>
    </div>
  ),
  // Controls CSS hides at both ends, as the sheet close button is on a desktop.
  hidden: () => (
    <div style={{ padding: '12px', display: 'flex', gap: '8px' }}>
      <button type="button" style={{ display: 'none' }}>
        Hidden first
      </button>
      <Button testId="inside-a">A</Button>
      <Button testId="inside-b">B</Button>
      <button type="button" style={{ display: 'none' }}>
        Hidden last
      </button>
    </div>
  ),
  text: () => <p style={{ padding: '12px', margin: '0' }}>Nothing to press here.</p>,
  link: () => (
    <p style={{ padding: '12px', margin: '0' }}>
      <a href="#story-link" data-testid="inside-link">
        Read more
      </a>
    </p>
  ),
  'link-first': () => (
    <div style={{ padding: '12px', display: 'flex', gap: '8px' }}>
      <a href="#story-link" data-testid="inside-link">
        Read more
      </a>
      <select aria-label="Network" data-testid="inside-select">
        <option>Paseo</option>
      </select>
    </div>
  ),
} satisfies Record<string, () => JSX.Element>;

function Harness(props: { content?: keyof typeof CONTENTS; handOver?: boolean }) {
  const [trigger, setTrigger] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  const [held, setHeld] = createSignal(true);
  const content = (): JSX.Element => CONTENTS[props.content ?? 'buttons']();
  return (
    <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
      {/* With `handOver` the popover lets the button go, as AuthButton does when the session drops. */}
      {props.handOver === true ? (
        <Button
          testId="let-go"
          onClick={() => {
            setHeld(false);
          }}
        >
          Let go
        </Button>
      ) : null}
      <Button
        ref={setTrigger}
        testId="trigger"
        onClick={() => {
          if (!held()) {
            onElse();
          }
        }}
      >
        Open
      </Button>
      <Popover
        id="story-popover"
        title="Example"
        trigger={held() ? trigger() : undefined}
        onOpenChange={onOpenChange}
        testId="story-popover-surface"
      >
        {content()}
      </Popover>
    </div>
  );
}

const meta = {
  title: 'Floating/Popover',
  component: Harness,
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  tags: ['!autodocs'],
  beforeEach: () => {
    onOpenChange.mockClear();
    onElse.mockClear();
  },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a dotli user, I press a button to open its anchored dialog with focus on the first control, and Escape closes it. */
export const Open: Story = {
  play: async ({ mount, step }) => {
    await step('When the popover and its button render', async () => {
      await mount();
    });
    await step('Then the button it holds announces the dialog it controls', async () => {
      const trigger = body.getByTestId('trigger');
      await waitFor(() => expect(trigger).toHaveAttribute('popovertarget', 'story-popover'));
      await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(trigger).toHaveAttribute('aria-controls', 'story-popover');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });
    await step('When I press the button', () => press('trigger'));
    await step('Then the anchored dialog is open, focus on its first control', async () => {
      const surface = body.getByTestId('story-popover-surface');
      await waitFor(() => expect(surface).toHaveAttribute('data-open'));
      await expect(surface).toHaveAttribute('role', 'dialog');
      await expect(surface).toHaveAccessibleName('Example');
      await expect(body.getByTestId('trigger')).toHaveAttribute('aria-expanded', 'true');
      await waitFor(() => expect(body.getByTestId('inside-a')).toHaveFocus());
    });
    await step('When I press Escape', async () => {
      await (await trustedInput()).keyboard('{Escape}');
    });
    await step('Then it closed and the button says so', async () => {
      await waitFor(() => expect(body.getByTestId('story-popover-surface')).not.toHaveAttribute('data-open'));
      await expect(body.getByTestId('trigger')).toHaveAttribute('aria-expanded', 'false');
    });
  },
};

/** As a phone user, I press the button and a bottom sheet opens with focus on its first control, and no anchored layer. */
export const PhoneSheet: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ step }) => {
    await step('When I press the button on a phone', () => press('trigger'));
    await step('Then a bottom sheet titled Example opens, and no anchored layer', async () => {
      await waitFor(() => expect(body.getByTestId('popover-sheet-title')).toHaveTextContent('Example'));
      const sheet = document.getElementById('story-popover');
      await expect(sheet).toHaveAttribute('data-open');
      await expect(document.querySelectorAll(':popover-open')).toHaveLength(0);
      await expect(onOpenChange.mock.calls).toEqual([[true]]);
    });
    await step('And focus is on its first control', async () => {
      await waitFor(() => expect(body.getByTestId('inside-a')).toHaveFocus());
    });
  },
};

/** As a phone user, I close the sheet with its button or Escape and focus returns to the trigger. */
export const PhoneClosesReturnFocus: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ step }) => {
    async function expectSettled(calls: boolean[][]): Promise<void> {
      await waitFor(() => expect(onOpenChange.mock.calls).toEqual(calls));
      await waitFor(() => expect(document.getElementById('story-popover')).not.toHaveAttribute('data-open'));
      await waitFor(() => expect(body.getByTestId('trigger')).toHaveFocus());
      // The sheet's content leaves once its slide out has played, the last step of the close.
      await waitFor(() => expect(body.queryByTestId('inside-a')).toBeNull(), { timeout: 2000 });
      await expect(body.getByTestId('trigger')).toHaveFocus();
    }
    await step('Given the sheet is open', () => press('trigger'));
    await step('When I press its close button', () => press('popover-sheet-close'));
    await step('Then it closed once and the trigger has focus', () => expectSettled([[true], [false]]));
    await step('When I open the sheet again', () => press('trigger'));
    await step('Then focus is on its first control', async () => {
      await waitFor(() => expect(body.getByTestId('inside-a')).toHaveFocus());
    });
    await step('When I press Escape', async () => {
      await (await trustedInput()).keyboard('{Escape}');
    });
    await step('Then it closed once more and the trigger has focus', () =>
      expectSettled([[true], [false], [true], [false]]),
    );
  },
};

/** As a phone user, I turn the screen with the popover open and it stays open with focus, as a sheet on the phone and anchored when wide again. */
export const FollowsTheViewportWhileOpen: Story = {
  play: async ({ step }) => {
    const { page } = await import('vitest/browser');
    const wide = { width: window.innerWidth, height: window.innerHeight };
    const popover = () => document.getElementById('story-popover');
    const isShown = () => popover()?.matches(':popover-open') === true;
    try {
      await step('Given the popover is open and anchored on a wide screen', async () => {
        await press('trigger');
        await waitFor(() => expect(isShown()).toBe(true));
      });
      await step('When the screen narrows to a phone', async () => {
        await page.viewport(390, 844);
      });
      await step('Then the popover is still open, as a sheet with focus inside', async () => {
        await waitFor(() => expect(body.getByTestId('popover-sheet-title')).toHaveTextContent('Example'));
        await expect(popover()).toHaveAttribute('data-open');
        await expect(body.getByTestId('trigger')).toHaveAttribute('aria-expanded', 'true');
        await waitFor(() => expect(popover()?.contains(document.activeElement)).toBe(true));
      });
      await step('When the screen widens again', async () => {
        await page.viewport(wide.width, wide.height);
      });
      await step('Then the popover is still open, anchored again with focus inside', async () => {
        await waitFor(() => expect(body.queryByTestId('popover-sheet-title')).toBeNull());
        await waitFor(() => expect(isShown()).toBe(true));
        await expect(body.getByTestId('trigger')).toHaveAttribute('aria-expanded', 'true');
        await waitFor(() => expect(popover()?.contains(document.activeElement)).toBe(true));
      });
    } finally {
      // The next story must not inherit the phone.
      await page.viewport(wide.width, wide.height);
    }
  },
};

/** As a dotli user, I press a button the popover let go and its own click runs and nothing opens. */
export const ReleasedTriggerOpensNothing: Story = {
  args: { handOver: true },
  play: async ({ mount, step }) => {
    await step('When the popover and its button render', async () => {
      await mount();
    });
    const trigger = () => body.getByTestId('trigger');
    await step('Then the popover holds the button as its trigger', async () => {
      await waitFor(() => expect(trigger()).toHaveAttribute('popovertarget', 'story-popover'));
    });
    await step('When the popover lets it go', () => press('let-go'));
    await step('Then the button is no longer its invoker', async () => {
      await waitFor(() => expect(trigger()).not.toHaveAttribute('popovertarget'));
    });
    await step('When I press the button', () => press('trigger'));
    await step('Then its own click ran and nothing opened', async () => {
      await expect(onElse).toHaveBeenCalledOnce();
      await expect(onOpenChange).not.toHaveBeenCalled();
      await expect(document.getElementById('story-popover')?.hasAttribute('data-open') ?? false).toBe(false);
    });
    await step('And the button lost the invoker, and kept its ARIA', async () => {
      await expect(trigger()).not.toHaveAttribute('popovertarget');
      await expect(trigger()).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(trigger()).toHaveAttribute('aria-controls', 'story-popover');
      await expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    });
  },
};

/** As a dotli user, I open a popover whose content cannot load and it closes again, including when I reopen it at once. */
export const LazyContentFails: Story = {
  args: { content: 'failing' },
  play: async ({ step }) => {
    await step('When I open the popover whose content cannot load', () => press('trigger'));
    await step('Then it opened, and closed again', async () => {
      await waitFor(() => expect(onOpenChange.mock.calls).toEqual([[true], [false]]));
      await waitFor(() => expect(document.getElementById('story-popover')).not.toHaveAttribute('data-open'));
      await expect(body.getByTestId('trigger')).toHaveAttribute('aria-expanded', 'false');
    });
    await step('When I open it again at once, while the failed content is still fading out', () => press('trigger'));
    await step('Then the content loaded afresh, failed again and closed again', async () => {
      await waitFor(() => expect(onOpenChange.mock.calls).toEqual([[true], [false], [true], [false]]));
      await waitFor(() => expect(document.getElementById('story-popover')).not.toHaveAttribute('data-open'));
    });
  },
};

/** As a keyboard user, I open a popover that starts with a link and focus lands on the first control, past the link. */
export const FirstControlTakesFocus: Story = {
  args: { content: 'link-first' },
  play: async ({ step }) => {
    await step('When I open a popover that starts with a link', openSurface);
    await step('Then focus is on its first control, past the link', async () => {
      await waitFor(() => expect(body.getByTestId('inside-select')).toHaveFocus());
    });
  },
};

/** As a keyboard user, I tab through a popover and focus skips disabled controls and unchecked radios and wraps at both ends. */
export const TabSkipsUncheckedRadiosAndDisabled: Story = {
  args: { content: 'radios' },
  play: async ({ step }) => {
    await step('When I open the popover', openSurface);
    await step('Then focus skipped the disabled button and the link without href', async () => {
      await waitFor(() => expect(body.getByTestId('inside-a')).toHaveFocus());
    });
    await step('When I press Shift+Tab on the first stop', pressShiftTab);
    await step('Then focus wrapped to the checked radio, the last stop', async () => {
      await expect(body.getByTestId('radio-on')).toHaveFocus();
    });
    await step('When I press Tab on it', pressTab);
    await step('Then focus wrapped to the first stop, past the unchecked radio', async () => {
      await expect(body.getByTestId('inside-a')).toHaveFocus();
    });
  },
};

/** As a keyboard user, I tab from a control out of the tab order and focus wraps to the right end of the popover. */
export const TabWrapsPastControlsOutOfTabOrder: Story = {
  args: { content: 'tab-order' },
  play: async ({ step }) => {
    await step('When I open the popover', openSurface);
    await step('Then focus is on the first stop', async () => {
      await waitFor(() => expect(body.getByTestId('a-allow')).toHaveFocus());
    });
    await step('When I press Tab between the stops', pressTab);
    await step('Then the browser moves on inside', async () => {
      await expect(body.getByTestId('b-ask')).toHaveFocus();
    });
    await step('When I press Tab on the last stop', pressTab);
    await step('Then focus wraps to the first', async () => {
      await expect(body.getByTestId('a-allow')).toHaveFocus();
    });
    await step('When I press Tab on a control out of the Tab order past the last stop', async () => {
      body.getByTestId('b-allow').focus();
      await pressTab();
    });
    await step('Then focus wraps to the first again', async () => {
      await expect(body.getByTestId('a-allow')).toHaveFocus();
    });
    await step('When I press Shift+Tab on one before the first stop', async () => {
      body.getByTestId('a-ask').focus();
      await pressShiftTab();
    });
    await step('Then focus wraps to the last', async () => {
      await expect(body.getByTestId('b-ask')).toHaveFocus();
    });
  },
};

/** As a keyboard user, I tab through a popover and focus wraps between its visible controls only. */
export const TabWrapsPastHiddenControls: Story = {
  args: { content: 'hidden' },
  play: async ({ step }) => {
    await step('When I open the popover', openSurface);
    await step('Then focus is on the first visible control', async () => {
      await waitFor(() => expect(body.getByTestId('inside-a')).toHaveFocus());
    });
    await step('When I press Shift+Tab', pressShiftTab);
    await step('Then focus wraps to the last visible control', async () => {
      await expect(body.getByTestId('inside-b')).toHaveFocus();
    });
    await step('When I press Tab', pressTab);
    await step('Then focus wraps to the first visible control', async () => {
      await expect(body.getByTestId('inside-a')).toHaveFocus();
    });
  },
};

/** As a keyboard user, I open a popover with nothing to press and focus stays on its surface. */
export const EmptySurfaceKeepsFocus: Story = {
  args: { content: 'text' },
  play: async ({ step }) => {
    await step('When I open a popover with nothing to press', openSurface);
    await step('Then the surface itself has focus', async () => {
      await waitFor(() => expect(body.getByTestId('story-popover-surface')).toHaveFocus());
    });
    await step('When I press Tab', pressTab);
    await step('Then focus stays on the surface', async () => {
      await expect(body.getByTestId('story-popover-surface')).toHaveFocus();
    });
  },
};

/** As a keyboard user, I open a popover whose only control is a link and the surface has focus, not the link. */
export const LinksOnlySurfaceFocusesItself: Story = {
  args: { content: 'link' },
  play: async ({ step }) => {
    await step('When I open a popover whose only control is a link', openSurface);
    await step('Then the surface has focus, not the link', async () => {
      await waitFor(() => expect(body.getByTestId('story-popover-surface')).toHaveFocus());
      await expect(body.getByTestId('inside-link')).not.toHaveFocus();
    });
  },
};

/** Buttons A and B, and a popover triggered by whichever one `held` names. */
function HeldHarness() {
  const [buttonA, setButtonA] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  const [buttonB, setButtonB] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });

  function readTrigger(): HTMLButtonElement | undefined {
    switch (held()) {
      case 'a':
        return buttonA();
      case 'b':
        return buttonB();
      case undefined:
        return undefined;
    }
  }
  return (
    <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
      <Button ref={setButtonA} testId="held-a">
        A
      </Button>
      <Button ref={setButtonB} testId="held-b">
        B
      </Button>
      <Popover id="story-held" title="Held" trigger={readTrigger()} onOpenChange={onOpenChange} testId="held-surface">
        <div style={{ padding: '12px' }}>
          <Button testId="held-inside">Inside</Button>
        </div>
      </Popover>
    </div>
  );
}

/** As a dotli user, I press a button the popover took back and it opens once. */
export const TriggerHandedBackOpensOnce: Story = {
  render: () => <HeldHarness />,
  beforeEach: () => {
    setHeld('a');
  },
  play: async ({ mount, step }) => {
    await step('When the popover renders holding A', async () => {
      await mount();
    });
    await step('Then the popover holds A, and B announces nothing', async () => {
      await waitFor(() => expect(body.getByTestId('held-a')).toHaveAttribute('popovertarget', 'story-held'));
      const other = body.getByTestId('held-b');
      await expect(other).not.toHaveAttribute('popovertarget');
      await expect(other).not.toHaveAttribute('aria-haspopup');
      await expect(other).not.toHaveAttribute('aria-expanded');
      await expect(other).not.toHaveAttribute('aria-controls');
    });
    await step('When it hands A to B', () => {
      setHeld('b');
    });
    await step('Then B is its invoker', async () => {
      await waitFor(() => expect(body.getByTestId('held-b')).toHaveAttribute('popovertarget', 'story-held'));
    });
    await step('When it hands B back to A', () => {
      setHeld('a');
    });
    await step('Then A is its invoker again and B is not', async () => {
      await waitFor(() => expect(body.getByTestId('held-a')).toHaveAttribute('popovertarget', 'story-held'));
      await expect(body.getByTestId('held-b')).not.toHaveAttribute('popovertarget');
    });
    await step('When I press A once', () => press('held-a'));
    await step('Then it opened once', async () => {
      await waitFor(() => expect(isHeldOpen()).toBe(true));
      await expect(onOpenChange.mock.calls).toEqual([[true]]);
    });
  },
};

/** As a dotli user, I lose a popover's button while it is open and it closes once with focus returning to the button. */
export const TriggerReleasedWhileOpenReturnsFocus: Story = {
  render: () => <HeldHarness />,
  beforeEach: () => {
    setHeld('a');
  },
  play: async ({ step }) => {
    await step('When I open the popover', () => press('held-a'));
    await step('Then focus is inside it', async () => {
      await waitFor(() => expect(body.getByTestId('held-inside')).toHaveFocus());
    });
    await step('When the popover lets its button go, as a session drop does', () => {
      setHeld(undefined);
    });
    await step('Then it closed once and focus went back to the button', async () => {
      await waitFor(() => expect(isHeldOpen()).toBe(false));
      await expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
      await waitFor(() => expect(body.getByTestId('held-a')).toHaveFocus());
    });
  },
};

/** As a dotli user, I lose a popover's button while focus is on the body and it closes and leaves focus alone. */
export const TriggerReleasedFocusElsewhereClosesOnly: Story = {
  render: () => <HeldHarness />,
  beforeEach: () => {
    setHeld('a');
  },
  play: async ({ step }) => {
    await step('When I open the popover', () => press('held-a'));
    await step('Then focus is inside it', async () => {
      await waitFor(() => expect(body.getByTestId('held-inside')).toHaveFocus());
    });
    await step('When focus drops to the body, as Safari leaves it, and the popover lets its button go', () => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      setHeld(undefined);
    });
    await step('Then it closed and left focus alone', async () => {
      await waitFor(() => expect(isHeldOpen()).toBe(false));
      await waitFor(() => expect(body.queryByTestId('held-inside')).toBeNull(), { timeout: 2000 });
      await expect(document.activeElement).toBe(document.body);
    });
  },
};

async function press(testId: string): Promise<void> {
  await (await trustedInput()).click(body.getByTestId(testId));
}

async function openSurface(): Promise<void> {
  await press('trigger');
  await appears('[data-testid="story-popover-surface"][data-open]');
}

async function pressTab(): Promise<void> {
  await (await trustedInput()).keyboard('{Tab}');
}

async function pressShiftTab(): Promise<void> {
  await (await trustedInput()).keyboard('{Shift>}{Tab}{/Shift}');
}

function isHeldOpen(): boolean {
  return document.getElementById('story-held')?.hasAttribute('data-open') === true;
}
