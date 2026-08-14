// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { vi } from "vitest";
import type {
  JsonRpcConnection,
  JsonRpcMessage,
  JsonRpcProvider,
  JsonRpcRequest,
} from "@polkadot-api/json-rpc-provider";

export interface ProviderHarness {
  provider: JsonRpcProvider;
  sent: JsonRpcRequest[];
  disconnect: () => void;
  emit: (message: JsonRpcMessage) => void;
}

export function createProviderHarness(): ProviderHarness {
  const sent: JsonRpcRequest[] = [];
  const disconnect = vi.fn();
  let onMessage: ((message: JsonRpcMessage) => void) | null = null;

  const provider: JsonRpcProvider = (listener): JsonRpcConnection => {
    onMessage = listener;
    return {
      send(message) {
        sent.push(message);
      },
      disconnect,
    };
  };

  return {
    provider,
    sent,
    disconnect,
    emit(message) {
      onMessage?.(message);
    },
  };
}
