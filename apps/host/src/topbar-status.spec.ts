// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage, resetAllStoresForTests } from '@dotli/shared/testing';
import { createChatConnections, createChatStore } from './runtime/chat/store.js';
import { labelToProductId } from './runtime/runtime-config.js';
import { setAuthState } from './runtime/state/auth.js';
import { setProductLoaded } from './runtime/state/product.js';
import { memoryChatRepo } from './runtime/chat/store.fake.js';
import { initChatPanelState } from './state/chat-panel.js';
import {
  actionRoom,
  capsuleStatus,
  createMorphCount,
  createPillPlacement,
  pageNeedsAction,
  pillBox,
  type PillBox,
} from './topbar-status.js';

/** A placement that records what it published. */
function recordingPlacement(): {
  place: (box: PillBox | null, atRest?: boolean) => void;
  published: (PillBox | null)[];
} {
  const published: (PillBox | null)[] = [];
  const placement = createPillPlacement(box => {
    published.push(box);
  });
  return {
    place: (box, atRest = true) => {
      placement(() => box, atRest);
    },
    published,
  };
}

let stopChatState: () => void = () => undefined;

afterEach(() => {
  stopChatState();
  stopChatState = () => undefined;
  resetAllStoresForTests();
});

describe('capsuleStatus', () => {
  it('As a user glancing at the capsule, its colour follows the network health', () => {
    // When / Then
    expect(capsuleStatus('idle', false, true).tone).toBe('idle');
    expect(capsuleStatus('err', false, true).tone).toBe('err');
  });

  it('As a user with a prompt waiting, the capsule leads with the action dot', () => {
    // When / Then
    expect(capsuleStatus('ok', false, true).action).toBe(false);
    expect(capsuleStatus('ok', true, true).action).toBe(true);
  });

  it('As a screen reader user, I hear when I go offline, and the line clears when I am back', () => {
    // When / Then
    expect(capsuleStatus('err', false, false).announcement).toBe('You are offline');
    expect(capsuleStatus('ok', false, true).announcement).toBe('');
  });
});

describe('pageNeedsAction', () => {
  it('As a user with unread chat, the capsule leads with the action dot', async () => {
    // Given a loaded chat product, logged in, with the panel closed
    const chat = createChatStore({ repo: memoryChatRepo(), connections: createChatConnections() });
    const local = memoryStorage();
    stopChatState = initChatPanelState(chat, () => local);
    const product = labelToProductId('chatty');
    setProductLoaded('chatty', product, { chat: true });
    setAuthState({ tag: 'Connected', session: { connected: true } });
    expect(pageNeedsAction()).toBe(false);

    // When the product posts
    await chat.postProductMessage(product, 'main', { tag: 'Text', value: { text: 'hi' } });

    // Then
    expect(pageNeedsAction()).toBe(true);
  });
});

describe('pill placement', () => {
  it('As a popover dropping from the pill, I read where the pill ends', () => {
    // When
    const box = pillBox({ right: 1100, bottom: 72, width: 760 }, 1440);

    // Then
    expect(box).toEqual({ inlineEnd: 340, bottom: 72 });
  });

  it('As a popover dropping from the pill, I read its box at rest, not a frame of a fold or reveal', () => {
    // Given a pill at rest
    const { place, published } = recordingPlacement();
    place({ inlineEnd: 340, bottom: 72 });

    // When the bar folds and morphs through other boxes
    place({ inlineEnd: 500, bottom: 38 }, false);
    place({ inlineEnd: 660, bottom: 12 }, false);

    // Then the pill's box stays, the one it reveals to
    expect(published).toEqual([{ inlineEnd: 340, bottom: 72 }]);

    // When the reveal ends wider
    place({ inlineEnd: 300, bottom: 72 });

    // Then
    expect(published.at(-1)).toEqual({ inlineEnd: 300, bottom: 72 });
  });

  it('As the page, an unchanged pill box leaves the root style alone', () => {
    // Given
    const { place, published } = recordingPlacement();
    place(pillBox({ right: 1100, bottom: 72.4, width: 760 }, 1440));

    // When
    place(pillBox({ right: 1100, bottom: 72.4, width: 760 }, 1440));

    // Then
    expect(published).toHaveLength(1);
  });

  it('As a menu on the landing page, I keep my own place while the bar is hidden', () => {
    // Given a hidden bar, which has no box
    const { place, published } = recordingPlacement();

    // When
    place(pillBox({ right: 0, bottom: 0, width: 0 }, 1440));

    // Then the menus fall back to their own place
    expect(published).toEqual([null]);
  });
});

describe('the bar morph', () => {
  it('As a popover dropping from the pill, I wait for the last of the bar morphs to end', () => {
    // Given two overlapping morphs
    const morphs = createMorphCount(() => true);
    morphs.start();
    morphs.start();

    // When / Then
    expect(morphs.end()).toBe(false);
    expect(morphs.running()).toBe(true);
    expect(morphs.end()).toBe(true);
    expect(morphs.running()).toBe(false);
    expect(morphs.end()).toBe(false);
  });

  it('As a popover dropping from the pill, I still read its box when a morph ended without its event', () => {
    // Given a fold that started and was dropped without a transitionend or transitioncancel
    const transitionsRunning = vi.fn(() => false);
    const morphs = createMorphCount(transitionsRunning);
    morphs.start();

    // When / Then
    expect(morphs.running()).toBe(false);
    expect(morphs.end()).toBe(false);
  });
});

describe('actionRoom', () => {
  it('As the action group, my room is the pill max width less the rest of its row, the address included', () => {
    // When: a pill whose max width is 700, with a 600 px row of which the group takes 200
    const room = actionRoom(700, 600, 200);

    // Then
    expect(room).toBe(300);
  });

  it('As the action group under a pill with no max width, I have no room to measure against', () => {
    // When / Then
    expect(actionRoom(Number.NaN, 600, 200)).toBeUndefined();
  });
});
