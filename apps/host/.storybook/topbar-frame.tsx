// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { SolidRenderer } from 'storybook-solidjs-vite';
import type { StoryContext } from 'storybook/internal/types';
import { expect, waitFor } from 'storybook/test';
import { isPhoneViewport } from '@dotli/ui';

/**
 * The host bar as surfaces read it. Its box matches the `--topbar-bottom` and `--topbar-inline-end` fallbacks, so they
 * resolve as on the host page. Like the host's bar it stays live over the phone sheets resting on it. `center` puts the
 * children in the URL pill's place, and `maxWidth` bounds the bar an action group in it measures.
 */
export function TopbarFrame(props: { children?: JSX.Element; center?: boolean; maxWidth?: number }): JSX.Element {
  return (
    <header
      id="topbar"
      data-chrome=""
      data-over-sheets=""
      data-testid="story-topbar"
      style={{
        position: 'fixed',
        top: '0',
        left: '0',
        right: '0',
        height: 'var(--topbar-height)',
        display: 'flex',
        'align-items': 'center',
        'justify-content': props.center === true ? 'center' : 'flex-end',
        gap: '8px',
        padding: '0 12px',
        'max-width': props.maxWidth === undefined ? undefined : `${String(props.maxWidth)}px`,
      }}
    >
      {props.children}
    </header>
  );
}

type Play = (ctx: StoryContext<SolidRenderer>) => Promise<void>;

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) {
    throw new Error(`No #${id}`);
  }
  return el;
}

/** The `Open` play of a surface: press its trigger, wait for the surface and its content. */
export function openSurface(ids: { trigger?: string; surface: string }): Play {
  return async ({ userEvent, step }) => {
    if (ids.trigger !== undefined) {
      const trigger = ids.trigger;
      await step('When I press its button', async () => {
        await reachable(byId(trigger));
        await userEvent.click(byId(trigger));
      });
    }
    await step('Then the surface is open with its content', async () => {
      await waitFor(() => expect(byId(ids.surface)).toHaveAttribute('data-open'));
      // Lazy bodies show a placeholder first.
      await waitFor(() => expect(byId(ids.surface).querySelector('[data-testid="popover-loading"]')).toBeNull());
    });
  };
}

/** The phone variant's guard: the story's viewport really crossed the phone breakpoint. */
export async function expectPhone(step: StoryContext<SolidRenderer>['step']): Promise<void> {
  await step('Given the phone viewport', async () => {
    await waitFor(() => expect(isPhoneViewport()).toBe(true));
  });
}

/**
 * Resolves once `button` takes a pointer: outside the action group, or in it once the bar has measured and kept the
 * button's item in the row rather than parking it (More is parked until something collapses into it).
 */
export async function reachable(button: HTMLElement): Promise<void> {
  const takesPointer = (): boolean => {
    const group = button.closest('#topbar-actions');
    return group === null || (group.hasAttribute('data-measured') && button.closest('[data-parked]') === null);
  };
  await waitFor(() => expect(takesPointer()).toBe(true));
}
