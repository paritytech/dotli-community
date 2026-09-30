// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, Errored, onSettled, Show, type Component } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { captureException } from '@dotli/metrics';
import { setChatWidth } from '../../product-frame-layout.js';
import { chatButtonVisible, chatPanelStore, setChatPanelElement, setChatPanelOpen } from '../../state/chat-panel.js';
import { useStore } from '../use-store.js';

/** How long an idle prefetch waits for the browser to go idle. */
const PREFETCH_TIMEOUT_MS = 2000;

/**
 * The docked product-chat panel (`aside#chat-panel`), an island of the host
 * page (see components/shell/islands.tsx). It docks to the right edge while
 * the chat-panel store says it is open, shrinking the product frame by its
 * width (product-frame-layout), and stretches into the topbar's strip while
 * the topbar is auto-hidden. Escape inside it closes it; the chat button
 * takes the focus back.
 *
 * Its contents (ChatPanel) are their own chunk, loaded when the browser is
 * idle once the chat button shows, or at once when the panel opens. A chunk
 * that fails to load is reported and the panel closes; the next open tries
 * again. So does a panel that throws while rendering: it renders afresh on
 * the next open.
 */
export function ChatDock(): JSX.Element {
  let aside: HTMLElement | undefined;
  const open = useStore(chatPanelStore, state => state.open);
  const width = useStore(chatPanelStore, state => state.width);
  const topbarVisible = useStore(chatPanelStore, state => state.topbarVisible);
  const buttonVisible = useStore(chatPanelStore, chatButtonVisible);

  const [panel, setPanel] = createSignal<Component | null>(null);
  let loading: Promise<void> | null = null;
  const load = (): Promise<void> =>
    (loading ??= import('./ChatPanel.js').then(
      ({ ChatPanel }) => {
        setPanel(() => ChatPanel);
      },
      (err: unknown) => {
        captureException(err, { kind: 'chat_panel_load_error' });
        loading = null;
        setChatPanelOpen(false);
      },
    ));

  /** Renders the broken panel afresh; set while it is broken. */
  let resetBroken: (() => void) | null = null;
  const onBroken = (err: unknown, reset: () => void): null => {
    if (resetBroken === null) {
      resetBroken = reset;
      captureException(err, { root: 'chat' });
      setChatPanelOpen(false);
    }
    return null;
  };

  createEffect(buttonVisible, visible => {
    if (!visible || loading !== null) {
      return;
    }
    const run = (): void => {
      void load();
    };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: PREFETCH_TIMEOUT_MS });
    } else {
      setTimeout(run, PREFETCH_TIMEOUT_MS);
    }
  });
  createEffect(open, isOpen => {
    if (!isOpen) {
      return;
    }
    const reset = resetBroken;
    resetBroken = null;
    reset?.();
    void load();
  });
  // The panel is border-box, so its width is exactly the room it takes.
  createEffect(
    () => (open() ? width() : 0),
    (px, previous) => {
      if (px !== 0 || (previous ?? 0) !== 0) {
        setChatWidth(px);
      }
    },
  );
  // The chat button hands the focus back unless the user moved it off the
  // panel (see setChatPanelElement).
  onSettled(() => (aside === undefined ? undefined : setChatPanelElement(aside)));

  return (
    <aside
      ref={el => {
        aside = el;
        el.addEventListener('keydown', ev => {
          if (ev.key === 'Escape') {
            setChatPanelOpen(false);
          }
        });
      }}
      class={['chat-panel', { 'topbar-hidden': !topbarVisible() }]}
      id="chat-panel"
      role="complementary"
      aria-label="Product chat"
      hidden={!open()}
      style={open() ? { width: `${String(width())}px` } : undefined}
    >
      <Show when={panel()}>
        {Panel => {
          const Loaded = Panel();
          return (
            <Errored fallback={(err, reset) => onBroken(err(), reset)}>
              <Loaded />
            </Errored>
          );
        }}
      </Show>
    </aside>
  );
}
