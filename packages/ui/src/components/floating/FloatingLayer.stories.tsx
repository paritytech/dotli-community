// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { trustedInput } from '@config/storybook/play';
import { appears } from '@dotli/ui/testing';
import { Button } from '../primitives/Button.js';
import { FloatingLayer } from './FloatingLayer.js';
import { AnchorBoundary, LayerTracker, type TrackedLayer } from './layerContext.js';
import { Popover } from './Popover.js';

const onOther = fn().mockName('onOther');
const onOpenChange = fn().mockName('onOpenChange');
const onOpenChangeA = fn().mockName('onOpenChangeA');
const onOpenChangeB = fn().mockName('onOpenChangeB');
const onLayerClose = fn().mockName('onLayerClose');
/** The layers the page tracks, as an auto-hiding bar tracks its own. */
const tracked = new Set<TrackedLayer>();
// The surface is portalled into the body, outside the story's canvas.
const body = within(document.body);

function Harness() {
  const [trigger, setTrigger] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  return (
    <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
      <Button
        testId="other"
        onClick={() => {
          onOther();
        }}
      >
        Other
      </Button>
      <Button ref={setTrigger} testId="trigger">
        Open
      </Button>
      <Popover
        id="story-popover"
        title="Example"
        trigger={trigger()}
        onOpenChange={onOpenChange}
        testId="story-popover-surface"
      >
        <div style={{ padding: '12px', display: 'flex', gap: '8px' }}>
          <Button testId="inside-a">A</Button>
          <Button testId="inside-b">B</Button>
        </div>
      </Popover>
      <iframe
        data-testid="product"
        title="product"
        style={{ position: 'fixed', inset: '120px 0 0 0', width: '100%', height: '200px', border: '0' }}
        srcdoc="<body style='margin:0;height:100vh;background:#335'><button>product</button></body>"
      />
    </div>
  );
}

/** A layer that runs its own closes, open below a text input that cannot be its invoker, beside plain text. */
function SelfDismissing() {
  const [trigger, setTrigger] = createSignal<HTMLInputElement | undefined>(undefined, { ownedWrite: true });
  const [open, setOpen] = createSignal(true);
  return (
    <div style={{ display: 'flex', gap: '72px', 'align-items': 'flex-start' }}>
      <input ref={setTrigger} type="text" aria-label="Name" data-testid="input" />
      <p data-testid="outside">Outside</p>
      <FloatingLayer
        id="story-self-dismiss"
        kind="self-dismiss"
        open={open()}
        onClose={reason => {
          onLayerClose(reason);
          setOpen(false);
        }}
        trigger={trigger}
        placement="trigger-start"
        testId="self-dismiss-surface"
      >
        <div style={{ padding: '12px' }}>Layer</div>
      </FloatingLayer>
    </div>
  );
}

/** Two popovers side by side, each placed under its own trigger, so neither covers the other's. */
function TwoPopovers() {
  function renderPopover(key: 'a' | 'b', onChange: (open: boolean) => void) {
    const [trigger, setTrigger] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
    return (
      <>
        <Button ref={setTrigger} testId={`trigger-${key}`}>
          Open {key.toUpperCase()}
        </Button>
        <Popover
          id={`story-popover-${key}`}
          title={key.toUpperCase()}
          trigger={trigger()}
          onOpenChange={onChange}
          testId={`surface-${key}`}
          placement="trigger-start"
        >
          <div style={{ padding: '12px' }}>
            <Button testId={`inside-${key}`}>Inside {key.toUpperCase()}</Button>
          </div>
        </Popover>
      </>
    );
  }

  return (
    <div style={{ display: 'flex', gap: '8px' }}>
      {renderPopover('a', onOpenChangeA)}
      {renderPopover('b', onOpenChangeB)}
    </div>
  );
}

const meta = {
  title: 'Floating/Closing',
  component: Harness,
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  tags: ['!autodocs'],
  beforeEach: () => {
    onOther.mockClear();
    onOpenChange.mockClear();
    onOpenChangeA.mockClear();
    onOpenChangeB.mockClear();
    onLayerClose.mockClear();
  },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a dotli user, I click another button while a popover is open and the popover closes and the button gets the click. */
export const ClickOutsideReachesTarget: Story = {
  play: async ({ step }) => {
    await step('Given the popover is open', openPopover);
    await step('When I click the Other button', async () => {
      await (await trustedInput()).click(body.getByTestId('other'));
    });
    await step('Then the popover closed and Other got the click', async () => {
      await waitFor(() => expect(getSurface()).not.toHaveAttribute('data-open'));
      await expect(onOther).toHaveBeenCalledOnce();
    });
  },
};

/** As a dotli user, I click inside the product frame and the open popover closes while focus stays in the frame. */
export const ClosesOnPressInProductFrame: Story = {
  play: async ({ step }) => {
    await step('Given the popover is open', openPopover);
    await step('When I click inside the product iframe', async () => {
      await (await trustedInput()).click(body.getByTestId('product'));
    });
    await step('Then the popover closed and focus stayed in the iframe', async () => {
      await waitFor(() => expect(getSurface()).not.toHaveAttribute('data-open'));
      await expect(document.activeElement).toBe(body.getByTestId('product'));
    });
  },
};

/** As a dotli user, I switch to another app or the browser's own UI and the open popover stays open. */
export const StaysOpenWhenTheWindowLosesFocus: Story = {
  play: async ({ step }) => {
    await step('Given the popover is open', openPopover);
    await step('When the window loses focus with no element of the page taking it', () => {
      window.dispatchEvent(new FocusEvent('blur'));
    });
    await step('Then the popover is still open', async () => {
      await expect(onOpenChange.mock.calls).toEqual([[true]]);
      await expect(getSurface()).toHaveAttribute('data-open');
    });
  },
};

/** As a keyboard user, I press Escape with focus on the body and the popover closes with focus and its ring back on its trigger. */
export const EscapeReturnsFocusToTrigger: Story = {
  play: async ({ step }) => {
    await step('Given the popover is open and focus is on the body (as Safari leaves it)', async () => {
      await openPopover();
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    await step('When I press Escape', async () => {
      await (await trustedInput()).keyboard('{Escape}');
    });
    await step('Then it closed and the trigger has focus with its ring', async () => {
      await waitFor(() => expect(getSurface()).not.toHaveAttribute('data-open'));
      await expect(body.getByTestId('trigger')).toHaveFocus();
      await expect(body.getByTestId('trigger').matches(':focus-visible')).toBe(true);
    });
  },
};

/** As a dotli user, I click the trigger of an open popover and it closes once. */
export const TriggerTogglesClosed: Story = {
  play: async ({ step }) => {
    await step('Given the popover is open', openPopover);
    await step('When I click the trigger again', async () => {
      await (await trustedInput()).click(body.getByTestId('trigger'));
    });
    await step('Then it is closed, once', async () => {
      await waitFor(() => expect(getSurface()).not.toHaveAttribute('data-open'));
      await expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
    });
  },
};

/** As a dotli user, I open a modal dialog and the open popover closes. */
export const ClosesWhenAModalOpens: Story = {
  play: async ({ step }) => {
    await step('Given the popover is open', openPopover);
    await step('When a modal dialog opens', () => {
      const dialog = document.createElement('dialog');
      document.body.append(dialog);
      dialog.showModal();
      dialog.close();
      dialog.remove();
    });
    await step('Then the popover closed', async () => {
      await waitFor(() => expect(getSurface()).not.toHaveAttribute('data-open'));
    });
  },
};

/** As a dotli user, I click another popover's trigger once and the first closes while the second opens with focus inside. */
export const OneClickMovesToAnotherPopover: Story = {
  render: () => <TwoPopovers />,
  play: async ({ step }) => {
    await step("When I click A's trigger", async () => {
      await (await trustedInput()).click(body.getByTestId('trigger-a'));
    });
    await step('Then popover A is open', async () => {
      await waitFor(() => expect(body.getByTestId('surface-a')).toHaveAttribute('data-open'));
    });
    await step("When I click B's trigger once", async () => {
      await (await trustedInput()).click(body.getByTestId('trigger-b'));
    });
    await step('Then A closed and B is open with focus inside it, each change reported once', async () => {
      await waitFor(() => expect(body.getByTestId('surface-b')).toHaveAttribute('data-open'));
      await expect(body.getByTestId('surface-a')).not.toHaveAttribute('data-open');
      await waitFor(() => expect(body.getByTestId('inside-b')).toHaveFocus());
      await expect(onOpenChangeA.mock.calls).toEqual([[true], [false]]);
      await expect(onOpenChangeB.mock.calls).toEqual([[true]]);
    });
  },
};

/** As a dotli user, I open a popover and the page tracks one open layer holding focus until I press Escape. */
export const PageTracksOpenLayer: Story = {
  render: () => (
    <LayerTracker value={trackLayer}>
      <Harness />
    </LayerTracker>
  ),
  play: async ({ step }) => {
    await step('When I open the popover on a page that tracks the layers below it', openPopover);
    await step('Then focus is inside the popover', async () => {
      await waitFor(() => expect(body.getByTestId('inside-a')).toHaveFocus());
    });
    await step('And the page sees one layer, open and holding the focus', async () => {
      const layers = [...tracked];
      await expect(layers).toHaveLength(1);
      await expect(layers[0]?.open()).toBe(true);
      await expect(layers[0]?.element()?.contains(document.activeElement)).toBe(true);
    });
    await step('When I press Escape', async () => {
      await (await trustedInput()).keyboard('{Escape}');
    });
    await step('Then the page sees it closed', async () => {
      await waitFor(() => expect(getSurface()).not.toHaveAttribute('data-open'));
      await expect([...tracked].map(layer => layer.open())).toEqual([false]);
    });
  },
};

/** As a keyboard user, I press Escape after the page hid the trigger and focus goes to the page's fallback. */
export const HiddenTriggerHandsFocusToBoundary: Story = {
  render: () => (
    <AnchorBoundary value={{ fallbackFocus: () => body.getByTestId('other') }}>
      <Harness />
    </AnchorBoundary>
  ),
  play: async ({ step }) => {
    await step('Given the popover is open and the page then hid its trigger', async () => {
      await openPopover();
      body.getByTestId('trigger').style.display = 'none';
    });
    await step('When I press Escape', async () => {
      await (await trustedInput()).keyboard('{Escape}');
    });
    await step("Then it closed and the boundary's fallback has focus", async () => {
      await waitFor(() => expect(getSurface()).not.toHaveAttribute('data-open'));
      await waitFor(() => expect(body.getByTestId('other')).toHaveFocus());
    });
  },
};

/**
 * As a dotli user typing in an input with a layer below it, I press in the input and the layer stays open, and I press
 * outside both and it closes as an outside press.
 */
export const SelfDismissKeepsItsTrigger: Story = {
  render: () => <SelfDismissing />,
  play: async ({ step }) => {
    const surface = body.getByTestId('self-dismiss-surface');
    await step('Given the layer is open', async () => {
      await waitFor(() => expect(surface).toHaveAttribute('data-open'));
    });
    await step('When I press in the input', async () => {
      await (await trustedInput()).click(body.getByTestId('input'));
    });
    await step('Then the layer is still open', async () => {
      await expect(surface).toHaveAttribute('data-open');
      await expect(onLayerClose).not.toHaveBeenCalled();
    });
    await step('When I press the text beside the input', async () => {
      await (await trustedInput()).click(body.getByTestId('outside'));
    });
    await step('Then the layer closed once, as an outside press', async () => {
      await waitFor(() => expect(surface).not.toHaveAttribute('data-open'));
      await expect(onLayerClose.mock.calls).toEqual([['outside']]);
    });
  },
};

function trackLayer(layer: TrackedLayer): () => void {
  tracked.add(layer);
  return () => {
    tracked.delete(layer);
  };
}

function getSurface(): HTMLElement {
  return body.getByTestId('story-popover-surface');
}

async function openPopover(): Promise<void> {
  await (await trustedInput()).click(body.getByTestId('trigger'));
  await appears('[data-testid="story-popover-surface"][data-open]');
}
