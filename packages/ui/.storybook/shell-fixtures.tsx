// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { SolidRenderer } from 'storybook-solidjs-vite';
import type { StoryContext } from 'storybook/internal/types';
import { expect, waitFor } from 'storybook/test';
import { isPhoneViewport } from '../src/phone-viewport.js';
import { ActionGroup } from '../src/components/shell/topbar/ActionGroup.js';

/**
 * The host bar as surfaces read it. Its box matches the `--topbar-bottom` and `--topbar-inline-end`
 * fallbacks, so they resolve as on the host page without topbar-status.ts.
 * `room` is the action group's width (narrow collapses into More), `center` the URL pill's place.
 */
export function TopbarFrame(props: { children?: JSX.Element; room?: number; center?: boolean }): JSX.Element {
  return (
    <header
      id="topbar"
      data-chrome=""
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
        padding: '0 12px',
      }}
    >
      {props.center === true ? (
        props.children
      ) : (
        <ActionGroup room={props.room === undefined ? undefined : () => props.room}>{props.children}</ActionGroup>
      )}
    </header>
  );
}

type Play = (ctx: StoryContext<SolidRenderer>) => Promise<void>;

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) {
    throw new Error(`No element #${id}`);
  }
  return el;
}

/** The `Open` play of a surface: press its trigger, wait for the surface and its content. */
export function openSurface(ids: { trigger?: string; surface: string }): Play {
  return async ({ userEvent, step }) => {
    if (ids.trigger !== undefined) {
      const trigger = ids.trigger;
      await step('When I press its button', async () => {
        // The bar parks a button (More before it has measured) out of reach.
        await waitFor(() => expect(getComputedStyle(byId(trigger)).pointerEvents).not.toBe('none'));
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

/** The phone variant's guard: the story's viewport really crossed PHONE_QUERY. */
export async function expectPhone(step: StoryContext<SolidRenderer>['step']): Promise<void> {
  await step('Given the phone viewport', async () => {
    await waitFor(() => expect(isPhoneViewport()).toBe(true));
  });
}
