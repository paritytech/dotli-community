// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Host-owned profile drawer (vanilla DOM).
//
// A product asks the host to show a profile it holds a reference to; the host
// fetches and decrypts it and renders it here, so the image never enters the
// product. The drawer opens immediately with a loading state, then shows the
// avatar or a failure message. It is not a blocking modal: it asks nothing,
// and presenting another profile replaces the one on screen.

export interface ProfileDrawerOptions {
  /** Product that asked for the presentation, shown as attribution. */
  readonly productId: string;
  /** Fetch and decrypt the avatar. Aborted when the drawer closes. */
  readonly loadAvatar: (signal: AbortSignal) => Promise<Uint8Array>;
}

export interface ProfileDrawerHandle {
  readonly element: HTMLElement;
  close(): void;
}

let current: ProfileDrawerHandle | null = null;

/**
 * Raster formats a profile image may use. Anything else, SVG included, is
 * refused rather than handed to the renderer.
 */
export function rasterImageType(bytes: Uint8Array): string | null {
  const starts = (...prefix: number[]): boolean =>
    prefix.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return "image/png";
  }
  if (starts(0xff, 0xd8, 0xff)) {
    return "image/jpeg";
  }
  if (starts(0x47, 0x49, 0x46, 0x38)) {
    return "image/gif";
  }
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function failureMessage(error: unknown): string {
  // Matched by name: WebCrypto and AbortSignal.timeout raise DOMExceptions
  // whose class need not be this realm's.
  const name = error instanceof Error ? error.name : undefined;
  if (name === "TimeoutError") {
    return "The profile could not be fetched. Try again later.";
  }
  if (name === "OperationError") {
    return "The profile could not be opened. The reference may be wrong or out of date.";
  }
  return "The profile is unavailable.";
}

export function showProfileDrawer(
  options: ProfileDrawerOptions,
): ProfileDrawerHandle {
  current?.close();

  const backdrop = document.createElement("div");
  backdrop.className = "profile-drawer-backdrop";

  const drawer = document.createElement("section");
  drawer.className = "profile-drawer";
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-modal", "true");
  drawer.setAttribute("aria-labelledby", "profile-drawer-title");

  const header = document.createElement("header");
  header.className = "profile-drawer-header";
  const heading = document.createElement("h2");
  heading.id = "profile-drawer-title";
  heading.textContent = "Profile";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "profile-drawer-close";
  closeBtn.setAttribute("aria-label", "Close profile");
  closeBtn.textContent = "×";
  header.append(heading, closeBtn);

  const avatar = document.createElement("div");
  avatar.className = "profile-drawer-avatar";
  const spinner = document.createElement("div");
  spinner.className = "spinner";
  avatar.appendChild(spinner);

  const status = document.createElement("p");
  status.className = "profile-drawer-status";
  status.setAttribute("role", "status");
  status.textContent = "Loading profile…";

  const attribution = document.createElement("p");
  attribution.className = "profile-drawer-attribution";
  attribution.textContent = `Shown by ${options.productId}. Seity profile content is self-described; dot.li does not verify it.`;

  drawer.append(header, avatar, status, attribution);
  backdrop.appendChild(drawer);
  document.body.appendChild(backdrop);

  const aborter = new AbortController();
  let objectUrl: string | null = null;
  let closed = false;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      handle.close();
    }
  };

  const handle: ProfileDrawerHandle = {
    element: drawer,
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      aborter.abort();
      document.removeEventListener("keydown", onKeyDown);
      backdrop.remove();
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
      if (current === handle) {
        current = null;
      }
    },
  };
  current = handle;

  closeBtn.addEventListener("click", () => {
    handle.close();
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) {
      handle.close();
    }
  });
  document.addEventListener("keydown", onKeyDown);
  closeBtn.focus();

  const fail = (message: string): void => {
    avatar.replaceChildren();
    avatar.classList.add("profile-drawer-avatar-empty");
    status.textContent = message;
    status.classList.add("profile-drawer-status-error");
  };

  options.loadAvatar(aborter.signal).then(
    (bytes) => {
      if (closed) {
        return;
      }
      const type = rasterImageType(bytes);
      if (type === null) {
        fail("The profile image is not a supported format.");
        return;
      }
      objectUrl = URL.createObjectURL(
        new Blob([bytes as Uint8Array<ArrayBuffer>], { type }),
      );
      const img = document.createElement("img");
      img.alt = "Profile picture";
      img.src = objectUrl;
      avatar.replaceChildren(img);
      status.textContent = "";
    },
    (error: unknown) => {
      if (closed) {
        return;
      }
      fail(failureMessage(error));
    },
  );

  return handle;
}
