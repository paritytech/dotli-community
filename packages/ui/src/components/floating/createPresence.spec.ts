// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createRoot, createSignal, flush } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { createPresence } from './createPresence.js';

describe('createPresence ending on a transition', () => {
  it('As content of a layer whose close starts a transition, I stay until the transition ends', () => {
    // Given open content on a target that runs a transition when it closes
    const target = createFakeTarget({ transitions: true });
    const layer = mount(target);

    // When it closes, and the transition then ends
    layer.write(false);
    const duringExit = layer.shown();
    target.dispatch('transitionend');

    // Then
    expect([duringExit, layer.shown()]).toEqual([true, false]);
  });

  it('As content of a layer whose close starts no transition, such as under reduced motion, I go at once', () => {
    // Given open content on a target that runs no transition
    const layer = mount(createFakeTarget({ transitions: false }));

    // When
    layer.write(false);

    // Then
    expect(layer.shown()).toBe(false);
  });

  it('As content reopened during its exit, I stay through the next exit when the first transition cancels', () => {
    // Given content closed, then reopened while its exit ran
    const target = createFakeTarget({ transitions: true });
    const layer = mount(target);
    layer.write(false);
    layer.write(true);
    target.dispatch('transitioncancel');

    // When it closes again
    layer.write(false);

    // Then
    expect(layer.shown()).toBe(true);
  });

  it('As content disposed during its exit, I leave no listener on the target', () => {
    // Given content closed while its exit runs
    const target = createFakeTarget({ transitions: true });
    const layer = mount(target);
    layer.write(false);

    // When
    layer.dispose();

    // Then
    expect(target.listening()).toBe(0);
  });
});

/** Presence ending on `target`'s transition, under a fresh owner, open at first. */
function mount(target: EventTarget & { getAnimations: () => readonly unknown[] }) {
  const [open, setOpen] = createSignal(true, { ownedWrite: true });
  const { presence, dispose } = createRoot(d => ({
    presence: createPresence({ open, exit: { kind: 'transition', target: () => target } }),
    dispose: d,
  }));
  flush();
  return {
    shown: () => presence() !== 0,
    write: (next: boolean): void => {
      setOpen(next);
      flush();
    },
    dispose,
  };
}

/** An element that runs a transition while `transitions` is set, and counts the listeners on it. */
function createFakeTarget({ transitions }: { transitions: boolean }) {
  const target = new EventTarget();
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  let listening = 0;
  return Object.assign(target, {
    getAnimations: (): readonly unknown[] => (transitions ? [{ transitionProperty: 'display' }] : []),
    addEventListener: (...args: Parameters<EventTarget['addEventListener']>): void => {
      listening += 1;
      add(...args);
    },
    removeEventListener: (...args: Parameters<EventTarget['removeEventListener']>): void => {
      listening -= 1;
      remove(...args);
    },
    listening: () => listening,
    dispatch: (type: 'transitionend' | 'transitioncancel'): void => {
      target.dispatchEvent(new Event(type));
      flush();
    },
  });
}
