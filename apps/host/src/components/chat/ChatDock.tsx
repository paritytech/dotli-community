// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type Accessor,
  createEffect,
  createSignal,
  Errored,
  lazy,
  Loading,
  onSettled,
  Show,
  untrack,
  useContext,
} from 'solid-js';
import type { JSX } from '@solidjs/web';
import { captureException } from '@dotli/metrics';
import { preloadWhenIdle } from '@dotli/ui-core';
import { ReporterContext } from '@dotli/ui';
import type { ChatConversation } from './chat.js';
import { type ChatPanelModule, loadChatPanel } from '../../lazy.js';
import s from './ChatDock.module.css';

const PageChatPanel = lazy(loadChatPanel, { export: 'ChatPanel' });

export interface ChatDockProps {
  open: Accessor<boolean>;
  /** In px. The panel is border-box, so this is exactly the room it takes. */
  width: Accessor<number>;
  topbarHidden: Accessor<boolean>;
  /** Whether the chat button shows, which loads the panel's code while the page is idle. */
  available: Accessor<boolean>;
  onClose: () => void;
  /** The width a drag on the panel's edge asks for, before any clamp. */
  onResize: (width: number) => void;
  /** The drag ended, so the width can be kept. */
  onResizeEnd: () => void;
  conversation: ChatConversation;
  /** Hands the panel's element over once it is on the page. Returns the hand back. */
  handOver?: ((panel: HTMLElement) => () => void) | undefined;
  /** Read once. Without one, the panel's own chunk. */
  loadPanel?: (() => Promise<ChatPanelModule>) | undefined;
}

/**
 * The docked product-chat panel. A chunk that fails to load or a panel that throws is reported and
 * the panel closes, so the next open tries again.
 */
export function ChatDock(props: ChatDockProps): JSX.Element {
  const loadPanel = untrack(() => props.loadPanel);
  const ChatPanel = loadPanel === undefined ? PageChatPanel : lazy(loadPanel, { export: 'ChatPanel' });
  const report = useContext(ReporterContext);
  let aside: HTMLElement | undefined;

  // Keeps the panel rendered while closed once it has opened.
  const [opened, setOpened] = createSignal(false);

  createEffect(
    () => props.available(),
    visible => (visible ? preloadWhenIdle(ChatPanel, report) : undefined),
  );
  createEffect(
    () => props.open(),
    isOpen => {
      if (isOpen) {
        setOpened(true);
      }
    },
  );
  // Lets the chat button take focus back on close unless the user moved it off the panel.
  onSettled(() => (aside === undefined ? undefined : props.handOver?.(aside)));

  return (
    <aside
      ref={el => {
        aside = el;
      }}
      onKeyDown={ev => {
        if (ev.key === 'Escape') {
          props.onClose();
        }
      }}
      class={s['panel']}
      data-topbar-hidden={props.topbarHidden() ? '' : undefined}
      id="chat-panel"
      role="complementary"
      aria-label="Product chat"
      hidden={!props.open()}
      style={{ width: `${String(props.width())}px` }}
    >
      <Show when={opened()}>
        <Errored
          fallback={(err, reset) => <Broken error={err()} reset={reset} open={props.open} onClose={props.onClose} />}
        >
          <Loading>
            <ChatPanel
              open={props.open}
              width={props.width}
              onClose={props.onClose}
              onResize={props.onResize}
              onResizeEnd={props.onResizeEnd}
              conversation={props.conversation}
            />
          </Loading>
        </Errored>
      </Show>
    </aside>
  );
}

/** Reports a broken panel and closes it, so the next open renders it afresh. */
function Broken(props: {
  error: unknown;
  reset: () => void;
  open: Accessor<boolean>;
  onClose: () => void;
}): JSX.Element {
  createEffect(
    () => props.error,
    error => {
      captureException(error, { flow: 'ui', step: 'root_render', tags: { root: 'chat' } });
      props.onClose();
    },
  );
  createEffect(
    () => props.open(),
    isOpen => {
      if (isOpen) {
        props.reset();
      }
    },
    { defer: true },
  );
  return null;
}
