// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { MoreMenu } from "@dotli/ui/components/shell/MoreMenu";
import { mountRoot } from "@dotli/ui/mount/root";
import { pointerPress, settle } from "../../helpers/solid";

const MORE_IDS = ["more-button", "more-popover"];

/**
 * Mount the real "More" menu the way mountIslands does: rendered as its own
 * root into a detached container, then swapped in for the page's static
 * `#more-button` and `#more-popover` (appended to the body when the page has
 * none). Returns the unmount, which also removes the live nodes.
 */
export function mountMoreMenu(): () => void {
  const container = document.createElement("div");
  const dispose = mountRoot("island:more", container, () => <MoreMenu />);
  const fresh: Element[] = [];
  for (const id of MORE_IDS) {
    const node = container.querySelector(`[id="${id}"]`);
    if (node === null) {
      throw new Error(`MoreMenu rendered no #${id}`);
    }
    const stale = document.getElementById(id);
    if (stale === null) {
      document.body.append(node);
    } else {
      stale.replaceWith(node);
    }
    fresh.push(node);
  }
  return () => {
    dispose();
    for (const node of fresh) {
      node.remove();
    }
  };
}

/** Open the More menu and tap the row that forwards to `targetId`. */
export async function tapMoreRow(targetId: string): Promise<void> {
  pointerPress(document.getElementById("more-button") as HTMLElement);
  await settle();
  pointerPress(
    document.querySelector(
      `#more-popover .more-row[data-target="${targetId}"]`,
    ) as HTMLElement,
  );
}
