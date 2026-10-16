// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, Errored, lazy, Loading, onSettled, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { captureException } from '@dotli/metrics';
import { setChatWidth } from '../../product-frame-layout.js';
import { chatButtonVisible, chatPanelStore, setChatPanelElement, setChatPanelOpen } from '../../state/chat-panel.js';
import { preloadWhenIdle } from '../idle.js';
import { useStore } from '../use-store.js';
import s from './ChatDock.module.css';

const ChatPanel = lazy(() => import('./ChatPanel.js'), { export: 'ChatPanel' });

/**
 * The docked product-chat panel. A chunk that fails to load or a panel that throws is reported and
 * the panel closes, so the next open tries again.
 */
export function ChatDock(): JSX.Element {
  let aside: HTMLElement | undefined;
  const open = useStore(chatPanelStore, state => state.open);
  const width = useStore(chatPanelStore, state => state.width);
  const topbarVisible = useStore(chatPanelStore, state => state.topbarVisible);
  const buttonVisible = useStore(chatPanelStore, chatButtonVisible);

  // Keeps the panel rendered while closed once it has opened.
  const [opened, setOpened] = createSignal(false);

  createEffect(buttonVisible, visible => (visible ? preloadWhenIdle(ChatPanel) : undefined));
  createEffect(open, isOpen => {
    if (isOpen) {
      setOpened(true);
    }
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
  // Lets the chat button take focus back on close unless the user moved it off the panel.
  onSettled(() => (aside === undefined ? undefined : setChatPanelElement(aside)));

  return (
    <aside
      ref={el => {
        aside = el;
      }}
      onKeyDown={ev => {
        if (ev.key === 'Escape') {
          setChatPanelOpen(false);
        }
      }}
      class={s['panel']}
      data-topbar-hidden={topbarVisible() ? undefined : ''}
      id="chat-panel"
      role="complementary"
      aria-label="Product chat"
      hidden={!open()}
      style={{ width: `${String(width())}px` }}
    >
      <Show when={opened()}>
        <Errored fallback={(err, reset) => <Broken error={err()} reset={reset} />}>
          <Loading>
            <ChatPanel />
          </Loading>
        </Errored>
      </Show>
    </aside>
  );
}

/** Reports a broken panel and closes it, so the next open renders it afresh. */
function Broken(props: { error: unknown; reset: () => void }): JSX.Element {
  const open = useStore(chatPanelStore, state => state.open);
  createEffect(
    () => props.error,
    error => {
      captureException(error, { flow: 'ui', step: 'root_render', tags: { root: 'chat' } });
      setChatPanelOpen(false);
    },
  );
  createEffect(
    open,
    isOpen => {
      if (isOpen) {
        props.reset();
      }
    },
    { defer: true },
  );
  return null;
}
