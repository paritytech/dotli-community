// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Host-owned profile drawer (vanilla DOM).
//
// A product asks the host to show a profile it holds a reference to; the host
// fetches and decrypts it and renders it here, so the image never enters the
// product. The drawer opens immediately with a loading state, then shows the
// avatar or a failure message. It is not a blocking modal: it asks nothing,
// and presenting another profile replaces the one on screen.

import { log } from "@dotli/shared/log";
import { createMoodRing, INTENSITY, MOOD_PALETTE, type MoodRingHandle } from "./mood-ring";
import { moodIsCurrent, type Mood } from "./profile-record";

/** What a reference opened to. Either half may be missing. */
export interface LoadedProfile {
  readonly avatar: Uint8Array | null;
  readonly mood?: Mood;
}

export interface ProfileDrawerOptions {
  /** Product that asked for the presentation, shown as attribution. */
  readonly productId: string;
  /** Fetch and decrypt the profile. Aborted when the drawer closes. */
  readonly loadProfile: (signal: AbortSignal) => Promise<LoadedProfile>;
}

const AVATAR_PX = 160;

function moodLine(mood: Mood, nowSecs = Date.now() / 1000): string {
  const hoursLeft = Math.max(1, Math.round((mood.setAt + mood.ttlSecs - nowSecs) / 3600));
  return `${MOOD_PALETTE[mood.kind].label} · ${INTENSITY[mood.intensity].label.toLowerCase()} · ${String(hoursLeft)} h left`;
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

  const portrait = document.createElement("div");
  portrait.className = "profile-drawer-portrait";
  const avatar = document.createElement("div");
  avatar.className = "profile-drawer-avatar";
  const spinner = document.createElement("div");
  spinner.className = "spinner";
  avatar.appendChild(spinner);
  portrait.appendChild(avatar);

  const moodText = document.createElement("p");
  moodText.className = "profile-drawer-mood";

  const status = document.createElement("p");
  status.className = "profile-drawer-status";
  status.setAttribute("role", "status");
  status.textContent = "Loading profile…";

  const attribution = document.createElement("p");
  attribution.className = "profile-drawer-attribution";
  attribution.textContent = `Shown by ${options.productId}. Seity profile content is self-described; dot.li does not verify it.`;

  drawer.append(header, portrait, moodText, status, attribution);
  backdrop.appendChild(drawer);
  document.body.appendChild(backdrop);

  const aborter = new AbortController();
  let objectUrl: string | null = null;
  let ring: MoodRingHandle | null = null;
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
      ring?.stop();
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

  options.loadProfile(aborter.signal).then(
    ({ avatar: bytes, mood }) => {
      if (closed) {
        return;
      }
      const currentMood = mood !== undefined && moodIsCurrent(mood) ? mood : undefined;
      if (currentMood !== undefined) {
        ring = createMoodRing(currentMood, AVATAR_PX);
        portrait.prepend(ring.element);
        moodText.textContent = moodLine(currentMood);
      }
      if (bytes === null) {
        if (currentMood === undefined) {
          fail("This person is not sharing a profile right now.");
        } else {
          avatar.replaceChildren();
          avatar.classList.add("profile-drawer-avatar-empty");
          status.textContent = "";
        }
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
      // Name and message only: no error on this path carries the reference.
      log.warn(
        "[profile] drawer load failed:",
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
      fail(failureMessage(error));
    },
  );

  return handle;
}
