// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The 18 typed host callbacks (11 groups), implemented for a terminal host.
// The generated adapter (`createWasmRawCallbacks`) turns these into the raw
// SCALE surface the wasm core calls. Hand-written SCALE callbacks are exactly
// the drift this package exists to avoid.

import { ok } from "neverthrow";
import type {
  AuthState,
  CoreStorageKey,
  RequiredHostCallbacks,
} from "@parity/truapi-host";
import type { ChainEndpoints, ChainPool } from "./chain-pool.js";
import { fromHex, toHex } from "./hex.js";
import type { KeyValueStore } from "./kv.js";
import type { HostPresenter } from "./presenter.js";
import { describeReview } from "./reviews.js";

export interface HostCallbackDeps {
  coreStore: KeyValueStore;
  productStore: KeyValueStore;
  pool: ChainPool;
  presenter: HostPresenter;
  endpoints: ChainEndpoints;
  /** Environment id advertised through `supportedChains` (RFC 0026). */
  network: string;
  theme: "Dark" | "Light";
  /** Optional preimage retrieval backend (P2P/IPFS). Default: always a miss. */
  lookupPreimage?: (key: Uint8Array) => Promise<Uint8Array | undefined>;
  onAuthState: (state: AuthState) => void;
  log?: (line: string) => void;
}

/**
 * Flatten a typed core-storage slot to a stable, legible backing key. Slot
 * tags are unique. The parameterized slots carry their parameters.
 */
export function coreSlot(key: CoreStorageKey): string {
  switch (key.tag) {
    case "AllowanceKeys":
      return `AllowanceKeys:${key.value.sessionId}`;
    case "PermissionAuthorization":
      return `PermissionAuthorization:${key.value.productId}:${key.value.request.tag}`;
    case "AutoSigningKey":
      return `AutoSigningKey:${key.value.productId}`;
    case "RingVrfRegistry":
      return `RingVrfRegistry:${toHex(key.value.rootPublicKey)}`;
    default:
      // Parameterless slots flatten to their tag. A NEW parameterized slot
      // landing here would collide across its parameters, so new engine
      // versions must be checked against this switch.
      return key.tag;
  }
}

const park = (): Promise<never> => new Promise<never>(() => {});

export function createHostCallbacks(
  deps: HostCallbackDeps,
): RequiredHostCallbacks {
  const {
    coreStore,
    productStore,
    pool,
    presenter,
    endpoints,
    network,
    theme,
    lookupPreimage,
    onAuthState,
    log,
  } = deps;
  let nextNotificationId = 1;

  return {
    navigation: {
      // NOT the pairing affordance. Pairing arrives as `AuthState.Pairing`.
      // This is "open a URL in the system browser", which a terminal host
      // hands to the user instead of guessing at an opener.
      async navigateTo(url) {
        presenter.openUrl(url);
      },
    },

    notifications: {
      async pushNotification(notification) {
        presenter.notify(
          notification.deeplink === undefined
            ? notification.text
            : `${notification.text} (${notification.deeplink})`,
        );
        return { id: nextNotificationId++ };
      },
      async cancelNotification(id) {
        // Notifications are printed, not retained. Cancelling is idempotently
        // a no-op by contract.
        log?.(`cancelNotification(${String(id)})`);
      },
    },

    permissions: {
      async devicePermission(request) {
        const granted = await presenter.confirm({
          title: `Allow access to: ${request}`,
          details: [],
          phoneVerifies: false,
        });
        return { granted };
      },
      async remotePermission(request) {
        const granted = await presenter.confirm({
          title: "Grant a product permission",
          details: [`permission: ${JSON.stringify(request.permission)}`],
          phoneVerifies: false,
        });
        return { granted };
      },
    },

    features: {
      async featureSupported(request) {
        // The only feature probe today is per-chain support. This host serves
        // exactly the chains it has endpoints for.
        const supported =
          request.tag === "Chain" &&
          endpoints[request.value.genesisHash] !== undefined;
        return { supported };
      },
      async supportedChains() {
        // Advertise the role-mapped subset of the endpoint map (RFC 0026).
        // Both advertisements answer from the same map, so they can never
        // disagree with `featureSupported` or with `chain.connect`.
        return {
          network,
          chains: Object.entries(endpoints).flatMap(
            ([genesisHash, endpoint]) =>
              endpoint.role === undefined
                ? []
                : [
                    {
                      identifier: endpoint.role,
                      // Endpoint keys are documented `0x`-prefixed hex.
                      genesisHash: genesisHash as `0x${string}`,
                    },
                  ],
          ),
        };
      },
    },

    productStorage: {
      // The core namespaces these keys itself
      // (`truapi:product-storage:v1:<len>:<productId>:<key>`). The key carries
      // NO account component, which is why the host clears this store on
      // logout (see CliHost).
      async read(key) {
        const hit = await productStore.get(key);
        return hit === null ? undefined : fromHex(hit);
      },
      async write(key, value) {
        await productStore.set(key, toHex(value));
      },
      async clear(key) {
        await productStore.delete(key);
      },
    },

    coreStorage: {
      async readCoreStorage(key) {
        const hit = await coreStore.get(coreSlot(key));
        return hit === null ? undefined : fromHex(hit);
      },
      async writeCoreStorage(key, value) {
        await coreStore.set(coreSlot(key), toHex(value));
      },
      async clearCoreStorage(key) {
        await coreStore.delete(coreSlot(key));
      },
    },

    chain: {
      connect(genesisHash) {
        return pool.connect(genesisHash);
      },
    },

    auth: {
      authStateChanged(state) {
        onAuthState(state);
      },
    },

    userConfirmation: {
      confirmUserAction(review) {
        return presenter.confirm(describeReview(review, { endpoints }));
      },
    },

    theme: {
      async *subscribeTheme() {
        yield ok(theme);
        // A terminal theme never changes mid-run. Park forever so the core's
        // subscription stays open instead of seeing an immediate
        // end-of-stream.
        await park();
      },
    },

    preimage: {
      async *lookupPreimage(key) {
        let value: Uint8Array | undefined;
        try {
          value = await lookupPreimage?.(key);
        } catch (error) {
          log?.(
            `lookupPreimage(${toHex(key).slice(0, 18)}…) failed: ${String(error)}`,
          );
          value = undefined;
        }
        yield ok(value);
        // Same contract as `theme`: emit once, then keep the stream open.
        await park();
      },
    },
  };
}
