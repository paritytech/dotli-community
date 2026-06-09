// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, existsSync } from "node:fs";
import type { FullConfig } from "@playwright/test";
import { disconnect } from "./helpers/signer-bot";
import { SESSION_FILE, type PersistedSession } from "./fixtures/paths";

const SVC_TOKEN = process.env.SIGNER_BOT_SVC_TOKEN ?? "";

export default async function globalTeardown(
  _config: FullConfig,
): Promise<void> {
  if (!SVC_TOKEN || !existsSync(SESSION_FILE)) {
    return;
  }
  try {
    const session = JSON.parse(
      readFileSync(SESSION_FILE, "utf-8"),
    ) as PersistedSession;
    await disconnect(session.botBase, SVC_TOKEN, session.sessionId);
    console.log(
      `[globalTeardown] disconnected sessionId=${session.sessionId.slice(0, 16)}…`,
    );
  } catch (e) {
    // Best-effort. The bot times sessions out anyway.
    console.warn(`[globalTeardown] disconnect failed: ${(e as Error).message}`);
  }
}
