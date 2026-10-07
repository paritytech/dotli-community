// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { Popover } from '../../../src/components/floating/Popover.js';
import { mouseClick, renderComponent, settle } from '../../helpers/solid.js';
import { byId } from '../../support.js';

const chunk = vi.hoisted(() => {
  let release = (): void => undefined;
  const arrived = new Promise<void>(resolve => {
    release = resolve;
  });
  return {
    arrived,
    release: () => {
      release();
    },
  };
});

vi.mock('../../../src/components/floating/PopoverSurface.js', async importOriginal => {
  await chunk.arrived;
  return importOriginal();
});

function Slow(props: { id: string; onOpenChange: (open: boolean) => void }) {
  const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  return (
    <>
      <button ref={setButton} id={`${props.id}-trigger`} type="button">
        Open {props.id}
      </button>
      <Popover id={props.id} title={props.id} trigger={button()} onOpenChange={props.onOpenChange}>
        <button type="button" id={`${props.id}-inside`}>
          Inside
        </button>
      </Popover>
    </>
  );
}

function isOpen(id: string): boolean {
  return document.getElementById(id)?.hasAttribute('data-open') === true;
}

describe('Popovers opened while their surface is on its way', () => {
  it('As a dotli user on a slow network, an opening shows when the surface arrives, unless I closed it or went on to another', async () => {
    // Given: three popovers, none of whose surface is in yet.
    const changes = { x: vi.fn<(open: boolean) => void>(), p: vi.fn(), q: vi.fn() };
    renderComponent(() => (
      <>
        <Slow id="x" onOpenChange={changes.x} />
        <Slow id="p" onOpenChange={changes.p} />
        <Slow id="q" onOpenChange={changes.q} />
      </>
    ));
    await settle();

    // When: X opens, and its button closes it again, with no layer for the invoker to close.
    mouseClick(byId('x-trigger'));
    await settle();

    // Then: open at once, with no surface yet.
    expect(changes.x.mock.calls).toEqual([[true]]);
    expect(byId('x-trigger').getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById('x')).toBeNull();

    // When
    mouseClick(byId('x-trigger'));
    await settle();

    // Then
    expect(changes.x.mock.calls).toEqual([[true], [false]]);
    expect(byId('x-trigger').getAttribute('aria-expanded')).toBe('false');

    // When: P opens from its focused button, then I go on to Q's.
    byId('p-trigger').focus();
    mouseClick(byId('p-trigger'));
    await settle();
    byId('q-trigger').focus();
    mouseClick(byId('q-trigger'));
    await settle();

    // When: the chunk arrives, as I watch what is shown and focused.
    const shown: string[] = [];
    const focused: string[] = [];
    const onToggle = (ev: Event): void => {
      if ((ev as ToggleEvent).newState === 'open') {
        shown.push((ev.target as HTMLElement).id);
      }
    };
    const onFocusIn = (ev: FocusEvent): void => {
      focused.push((ev.target as HTMLElement).id);
    };
    document.addEventListener('beforetoggle', onToggle, true);
    document.addEventListener('focusin', onFocusIn, true);
    chunk.release();

    // Then: Q shows, open, with focus inside; P, which I left, closed without showing; X stays shut.
    await vi.waitFor(() => {
      expect(isOpen('q')).toBe(true);
    });
    await settle();
    expect(document.activeElement).toBe(byId('q-inside'));
    expect(changes.q.mock.calls).toEqual([[true]]);
    expect(changes.p.mock.calls).toEqual([[true], [false]]);
    expect(isOpen('p')).toBe(false);
    expect(byId('p-trigger').getAttribute('aria-expanded')).toBe('false');
    expect(changes.x.mock.calls).toEqual([[true], [false]]);
    expect(isOpen('x')).toBe(false);
    expect(shown).toEqual(['q']);
    expect(focused).toEqual(['q-inside']);
    document.removeEventListener('beforetoggle', onToggle, true);
    document.removeEventListener('focusin', onFocusIn, true);
  });
});
