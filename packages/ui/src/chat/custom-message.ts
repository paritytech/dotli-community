// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Mounts one custom-message cell in the chat panel.
//
// The visibility gate is not a rendering optimization, it gates the
// subscription: a tree is live and each open render is work the product
// is doing, so a long history would otherwise hold one per row for rows
// nobody is looking at. The observer starts the subscription when the
// cell scrolls in and drops it when it leaves, like the desktop host.

import { bytesToHex, hexToBytes } from "@parity/truapi/scale";
import { renderCustomMessage, userTriggerAction } from "./service";
import { renderCustomNode } from "./custom-renderer";

export interface CustomMessageMount {
  productId: string;
  roomId: string;
  messageId: string;
  messageType: string;
  /** Stored product-defined payload, hex-encoded. */
  payload: string;
}

/**
 * Render a live custom message into `container`. Returns a disposer that
 * stops the observer and any open render subscription; callers must invoke
 * it before dropping the container, replaced rows included.
 */
export function mountCustomMessage(
  container: HTMLElement,
  mount: CustomMessageMount,
): () => void {
  const root = document.createElement("div");
  root.className = "chat-custom-root";
  setPlaceholder(root, "Loading…");
  container.appendChild(root);

  const onAction = (actionId: string, payload?: Uint8Array): void => {
    userTriggerAction(mount.productId, mount.roomId, {
      messageId: mount.messageId,
      actionId,
      payload: payload === undefined ? undefined : bytesToHex(payload),
    }).catch(() => {
      setPlaceholder(root, "The app could not be reached.");
    });
  };

  let disposed = false;
  let stopRender: (() => void) | null = null;

  const startRender = (): void => {
    if (disposed || stopRender !== null) {
      return;
    }
    stopRender = renderCustomMessage(
      mount.productId,
      {
        messageId: mount.messageId,
        messageType: mount.messageType,
        payload: hexToBytes(mount.payload),
      },
      {
        onUpdate: (node) => {
          if (disposed) {
            return;
          }
          const rendered = renderCustomNode(node, onAction);
          root.replaceChildren(...(rendered === null ? [] : [rendered]));
        },
        // A failed render may have delivered a partial tree, which must not
        // stand as final; replace it with a neutral fallback.
        onError: () => {
          if (!disposed) {
            setPlaceholder(root, "This message can’t be shown right now.");
          }
        },
      },
    );
  };

  const stop = (): void => {
    if (stopRender !== null) {
      stopRender();
      stopRender = null;
    }
  };

  let observer: IntersectionObserver | null = null;
  if (typeof IntersectionObserver === "undefined") {
    startRender();
  } else {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          startRender();
        } else {
          stop();
        }
      }
    });
    observer.observe(container);
  }

  return () => {
    disposed = true;
    observer?.disconnect();
    stop();
  };
}

function setPlaceholder(root: HTMLElement, text: string): void {
  const placeholder = document.createElement("span");
  placeholder.className = "chat-custom-placeholder";
  placeholder.textContent = text;
  root.replaceChildren(placeholder);
}
