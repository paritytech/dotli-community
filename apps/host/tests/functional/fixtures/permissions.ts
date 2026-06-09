// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Permission fixtures.
 */

import type { BrowserContext } from "@playwright/test";
import { DOMAIN } from "../../env";

export const BROWSER_PERMISSIONS = [
  "camera",
  "microphone",
  "geolocation",
  "notifications",
  "clipboard-read",
  "clipboard-write",
] as const;

const DOTLI_PERMISSIONS = [
  "Notifications",
  "Camera",
  "Microphone",
  "Location",
  "Bluetooth",
  "NFC",
  "Clipboard",
  "Biometrics",
  "ChainSubmit",
  "PreimageSubmit",
  "StatementSubmit",
] as const;

export async function seedPermissions(context: BrowserContext): Promise<void> {
  await context.addInitScript(
    ({ domain, perms }: { domain: string; perms: readonly string[] }) => {
      try {
        const granted: Record<string, string> = {};
        for (const p of perms) {
          granted[p] = "allow";
        }
        localStorage.setItem(
          `dotli:permissions:${domain}`,
          JSON.stringify(granted),
        );
      } catch (err) {
        console.warn("[seedPermissions] localStorage seed failed", err);
      }
    },
    { domain: DOMAIN, perms: DOTLI_PERMISSIONS },
  );
}
