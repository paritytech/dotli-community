// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { chatButtonVisible, chatPanelStore } from '../../state/chat-panel.js';
import { useStore } from '../use-store.js';
import { createPopover } from './popover.js';

/**
 * The mobile "More" button and its flyout, which collapses Chat,
 * Permissions, Theme and Settings into one menu. Each row forwards its tap as
 * a click on the real button named by its `data-target` (keeping the tap's
 * `detail`, 0 for a keyboard choice), looked up by id at click time, so it
 * reaches whichever element holds that id then: the live island, or the
 * static button before it is swapped in (whose click the islands loader
 * holds back and replays). The Chat row shows whenever the chat button
 * does.
 *
 * The flyout is a modal menu, like Radix DropdownMenu (createPopover's
 * `menu` mode, which owns its keys and focus), with the rows as its menu
 * items. Choosing a row closes the flyout and hands focus back to the More
 * button, then forwards the click, so the surface it opens takes focus as
 * its own mode dictates, and hands it back to the More button when it
 * closes (its own button being hidden on the narrow screens that show this
 * menu).
 */
export function MoreMenu(): JSX.Element {
  let button: HTMLButtonElement | undefined;
  let popover: HTMLDivElement | undefined;
  const menu = createPopover({
    mode: 'menu',
    trigger: () => button,
    surface: () => popover,
  });
  // Only the flag: the store is written on every chat message and every
  // move of a panel-width drag.
  const chatVisible = useStore(chatPanelStore, chatButtonVisible);

  const onClick = (e: MouseEvent): void => {
    const row = (e.target as Element).closest<HTMLElement>('.more-row');
    if (row === null) {
      return;
    }
    // The row's own click must not reach a document-level close-outside
    // listener, which would see it as outside the popover it opens.
    e.stopPropagation();
    menu.onItemChosen();
    const targetId = row.dataset['target'];
    if (targetId !== undefined) {
      // With the row click's detail: 0 for a keyboard choice, which opens a
      // menu (the theme menu) on its first item, as a keyboard opening does.
      document.getElementById(targetId)?.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          composed: true,
          detail: e.detail,
        }),
      );
    }
  };

  return (
    <>
      <button
        ref={el => {
          button = el;
          el.addEventListener('click', menu.toggle);
        }}
        id="more-button"
        class="topbar-btn topbar-more-btn"
        title="More"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={menu.open() ? 'true' : 'false'}
        aria-controls="more-popover"
      >
        <span class="hamburger" aria-hidden="true">
          <span class="hamburger-bar" />
          <span class="hamburger-bar" />
          <span class="hamburger-bar" />
        </span>
      </button>
      <div
        ref={el => {
          popover = el;
          el.addEventListener('click', onClick);
        }}
        class={['more-popover', { open: menu.open() }]}
        id="more-popover"
        role="menu"
        aria-labelledby="more-button"
        tabindex="-1"
      >
        <button
          class="more-row"
          id="more-row-chat"
          role="menuitem"
          tabindex="-1"
          data-target="chat-button"
          hidden={!chatVisible()}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span>Chat</span>
        </button>
        <button class="more-row" role="menuitem" tabindex="-1" data-target="permissions-button">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span>Permissions</span>
        </button>
        <button class="more-row" role="menuitem" tabindex="-1" data-target="theme-toggle">
          <svg
            class="more-row-icon-sun"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" />
            <line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" />
            <line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
          <svg
            class="more-row-icon-moon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
          <svg
            class="more-row-icon-system"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
          <span>Theme</span>
        </button>
        <button class="more-row" role="menuitem" tabindex="-1" data-target="mode-button">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span>Settings</span>
        </button>
      </div>
    </>
  );
}
