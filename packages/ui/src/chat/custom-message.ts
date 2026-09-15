// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Visibility gates the product subscription and all resources of its tree.
// Offscreen history must not keep product workers or image URLs alive.

import type { RenderContext } from "@parity/truapi";
import { bytesToHex } from "@parity/truapi/scale";
import {
  loadRendererImage,
  render,
  userTriggerRendererAction,
} from "./service";
import { renderNode } from "./custom-renderer";

export interface CustomMessageMount {
  productId: string;
  roomId: string;
  messageId: string;
  messageType: string;
  /** Stored product-defined payload, hex-encoded. */
  payload: `0x${string}`;
}

/** Mount one live body; dispose before removing or replacing its cell. */
export function mountCustomMessage(
  container: HTMLElement,
  mount: CustomMessageMount,
): () => void {
  const root = document.createElement("div");
  root.className = "chat-custom-root";
  setPlaceholder(root, "Loading…");
  container.appendChild(root);
  const context: RenderContext = {
    tag: "ChatMessage",
    value: {
      roomId: mount.roomId,
      messageId: mount.messageId,
      messageType: mount.messageType,
    },
  };

  let disposed = false;
  let stopRender: (() => void) | null = null;

  const startRender = (): void => {
    if (disposed || stopRender !== null) {
      return;
    }
    const lifecycle = { active: true };
    let ended = false;
    let tree: AbortController | null = null;
    let unsubscribe: (() => void) | undefined;
    const stop = (): void => {
      lifecycle.active = false;
      tree?.abort();
      unsubscribe?.();
      unsubscribe = undefined;
    };
    // Install the gate before calling render: a sink can terminate synchronously.
    stopRender = stop;
    const fail = (): void => {
      if (!lifecycle.active) {
        return;
      }
      ended = true;
      stop();
      setPlaceholder(root, "This message can’t be shown right now.");
    };
    const subscription = render(
      mount.productId,
      { context, payload: mount.payload },
      {
        onUpdate: (node) => {
          if (!lifecycle.active || ended) {
            return;
          }
          tree?.abort();
          const resources = new AbortController();
          tree = resources;
          try {
            const rendered = renderNode(
              node,
              (actionId, payload) => {
                if (!lifecycle.active || resources.signal.aborted) {
                  return;
                }
                void userTriggerRendererAction(mount.productId, {
                  context,
                  actionId,
                  payload: payload === undefined ? "0x" : bytesToHex(payload),
                }).catch(() => {
                  if (!resources.signal.aborted) {
                    fail();
                  }
                });
              },
              {
                signal: resources.signal,
                loadImage: (source, signal) =>
                  loadRendererImage(mount.productId, source, signal),
                onError: fail,
              },
            );
            root.replaceChildren(...(rendered === null ? [] : [rendered]));
          } catch {
            fail();
          }
        },
        onComplete: () => {
          ended = true;
        },
        // A failed stream's partial tree must never stand as final.
        onError: fail,
      },
    );
    if (lifecycle.active) {
      unsubscribe = subscription;
    } else {
      subscription();
    }
  };

  const stop = (): void => {
    if (stopRender !== null) {
      stopRender();
      stopRender = null;
      setPlaceholder(root, "Loading…");
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
