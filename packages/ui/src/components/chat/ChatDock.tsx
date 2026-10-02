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

/** The panel's contents, their own chunk. */
const ChatPanel = lazy(() => import('./ChatPanel.js'), { export: 'ChatPanel' });

/**
 * The docked product-chat panel (`aside#chat-panel`), an island of the host
 * page (see src/islands/). It docks to the right edge while
 * the chat-panel store says it is open, shrinking the product frame by its
 * width (product-frame-layout), and stretches into the topbar's strip while
 * the topbar is auto-hidden (`data-topbar-hidden`). Escape inside it closes it; the chat button
 * takes the focus back.
 *
 * Its contents (ChatPanel) are their own chunk, preloaded when the browser
 * is idle once the chat button shows, and rendered from the first open on.
 * A chunk that fails to load, or a panel that throws while rendering, is
 * reported and the panel closes; the next open tries again.
 */
export function ChatDock(): JSX.Element {
  let aside: HTMLElement | undefined;
  const open = useStore(chatPanelStore, state => state.open);
  const width = useStore(chatPanelStore, state => state.width);
  const topbarVisible = useStore(chatPanelStore, state => state.topbarVisible);
  const buttonVisible = useStore(chatPanelStore, chatButtonVisible);

  // Rendered once the panel first opens, and kept while it is closed.
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
  // The chat button hands the focus back unless the user moved it off the
  // panel (see setChatPanelElement).
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

/**
 * The panel broke: report it and close, after it renders. The next open
 * renders the panel afresh.
 */
function Broken(props: { error: unknown; reset: () => void }): JSX.Element {
  const open = useStore(chatPanelStore, state => state.open);
  createEffect(
    () => props.error,
    error => {
      captureException(error, { root: 'chat' });
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
