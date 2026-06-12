// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Host container bridge
//
// Bridges the host (dot.li) and the SPA loaded in the iframe using
// @novasamatech/host-container's postMessage-based protocol.
//
// Supports nested dApps: when a dApp embeds another dApp via iframe,
// the nested bridge detector dynamically creates additional bridges
// for each descendant dApp that sends protocol messages to window.top.

import {
  createDefaultLogger,
  CreateTransactionErr,
  DeriveEntropyErr,
  GenericError,
  GetUserIdErr,
  LoginErr,
  PaymentBalanceErr,
  PaymentRequestErr,
  PaymentStatusErr,
  PaymentTopUpErr,
  PreimageSubmitErr,
  PushNotificationError,
  RequestCredentialsErr,
  ResourceAllocationErr,
  SigningErr,
  StatementProofErr,
  StorageErr,
  toHex,
} from "@novasamatech/host-api";
import type { Provider } from "@novasamatech/host-api";
import {
  createContainer,
  createIframeProvider,
  createRateLimiter,
  deriveProductEntropyFromSource,
} from "@novasamatech/host-container";
import type { Container, RateLimiter } from "@novasamatech/host-container";
import type { SignedStatement } from "@novasamatech/sdk-statement";
import {
  createSr25519Prover,
  type StatementStoreAdapter,
} from "@novasamatech/statement-store";
import { errAsync, fromPromise, okAsync, type ResultAsync } from "neverthrow";
import { emitDotliDebugEvent } from "@dotli/truapi-debug/dotli-debug-bus";
import { isLocalhost, BASE_DOMAIN } from "@dotli/config/config";
import {
  getPermissionStatus,
  isEnforceableDevicePermission,
  setPermissionStatus,
  type PermissionName,
} from "./permissions";
import { showPermissionRequestModal } from "./permission-modal";
import { showAllocationRequestModal } from "./allocation-modal";
import { queueWalletFlow } from "./wallet-queue";

import type { UserSession } from "@novasamatech/host-papp";
import {
  getAllowanceService,
  getAuthState,
  getStatementStore,
  onAuthStateChange,
  onStatementStoreReady,
  readSessionSecret,
  requestLogin,
  type AuthState,
} from "@dotli/auth/auth";
import {
  showCreateTransactionModal,
  showSignPayloadModal,
  showSignRawModal,
  type ContainerCreateTransactionPayload,
} from "@dotli/auth/signing";
import {
  deriveProductPublicKey,
  productPublicKeyToAddress,
} from "@dotli/auth/account";
import {
  createRemoteChainProvider,
  isRemoteChainSupported,
} from "@dotli/protocol/client";
import { MAX_NESTED_BRIDGES } from "@dotli/config/config";
import { dotNsUrl } from "@dotli/shared/dotns-url";
import { log } from "@dotli/shared/log";
import { getBackend } from "@dotli/config/mode";
import { computePreimageKey, hashToCid } from "@dotli/content/preimage";
import { fetchFromIpfs } from "@dotli/content/ipfs";
import { submitPreimageAsUser } from "./preimage-submit";
import { showNotification } from "./notification";
import {
  cancelNotification,
  scheduleNotification,
} from "./scheduled-notifications";
import { showAliasPermissionModal } from "./alias-permission-modal";
import { showPreimageSubmitModal } from "./preimage-modal";
import {
  mapFromHostSignedStatement,
  mapFromHostStatement,
  mapSdkProof,
  mapSdkSignedStatement,
} from "./statement-store-mapping";

function getSession(): UserSession | null {
  const state = getAuthState();
  return state.status === "authenticated" ? state.session : null;
}

function subscribeSession(
  callback: (session: ReturnType<typeof getSession>) => void,
): () => void {
  callback(getSession());
  return onAuthStateChange((state: AuthState) => {
    callback(state.status === "authenticated" ? state.session : null);
  });
}

// localhost proxy and webcontainer previews are developer affordances for
// running a `.dot` app before it's deployed.
function isDevPreviewLabel(label: string): boolean {
  return (
    label.startsWith("localhost:") || dotNsUrl.isWebcontainerPreviewHost(label)
  );
}

/**
 * Derive the product-id from an iframe label.
 *
 * Dev previews (localhost proxy, webcontainer) keep the bare host label. dotNs
 * products get the `.dot` suffix appended. Same rule encoded in
 * `isProductAccountValid`.
 */
function labelToProductIdentifier(label: string): string {
  return isDevPreviewLabel(label) ? label : `${label}.dot`;
}

function labelAcceptsIdentifier(label: string, id: string): boolean {
  return (
    dotNsUrl.isProductIdentifier(id) || id === labelToProductIdentifier(label)
  );
}

// Dev previews are permissive. A deployed `.dot` must sign as its own identifier.
function isProductAccountValid(label: string, accountId: string): boolean {
  if (isDevPreviewLabel(label)) {
    return labelAcceptsIdentifier(label, accountId);
  }
  return accountId === labelToProductIdentifier(label);
}

function wireContainerHandlers(
  container: Container,
  label: string,
  storagePrefix: string,
): () => void {
  // One queue-strategy limiter per call-site domain. Browser parity
  // (browser/src/shared/rateLimiter/index.ts): 20 req/s, 100 queued.
  // Each limiter owns a refill timer that must be released on teardown.

  function makeLimiter(onDrop: () => unknown): RateLimiter {
    return createRateLimiter({
      strategy: "queue",
      maxRequestsPerInterval: 20,
      intervalMs: 1000,
      maxQueuedRequests: 100,
      onDrop,
    });
  }

  const aliasLimiter = makeLimiter(
    () => new RequestCredentialsErr.Unknown({ reason: "Rate limited" }),
  );
  const permissionLimiter = makeLimiter(
    () => new GenericError({ reason: "Rate limited" }),
  );
  const submitLimiter = makeLimiter(
    () => new GenericError({ reason: "Rate limited" }),
  );
  const preimageLimiter = makeLimiter(
    () => new PreimageSubmitErr.Unknown({ reason: "Rate limited" }),
  );

  let chainConnectionWarned = false;

  function warnOnRawChainConnection(genesisHash: string): void {
    if (chainConnectionWarned) {
      return;
    }
    chainConnectionWarned = true;

    log.warn(
      `[${label}] Raw chain connection requested (genesis=${genesisHash.slice(0, 10)}…, storage=${storagePrefix})`,
    );

    showNotification({
      label: "Direct Chain Access",
      text: "This app uses a direct chain connection instead of the recommended host API.",
      dismissMs: 8000,
      browserNotification: false,
    });
  }

  container.handleFeatureSupported((params, { ok }) => {
    switch (params.tag as string) {
      case "Chain":
        return ok(isRemoteChainSupported(params.value));
      default:
        return ok(false);
    }
  });

  container.handleChainConnection((genesisHash) => {
    warnOnRawChainConnection(genesisHash);
    return createRemoteChainProvider(genesisHash);
  });

  container.handleAccountGet(
    ([dotNsIdentifier, derivationIndex], { ok, err }) => {
      const session = getSession();
      if (!session) {
        return err(new RequestCredentialsErr.NotConnected(undefined));
      }

      if (!labelAcceptsIdentifier(label, dotNsIdentifier)) {
        return err(new RequestCredentialsErr.DomainNotValid(undefined));
      }

      const publicKey = deriveProductPublicKey(
        session.rootAccountId,
        dotNsIdentifier,
        derivationIndex,
      );

      return ok({ publicKey });
    },
  );

  // The web host has no user-imported accounts,
  // only HDKD-derived product accounts.
  container.handleGetLegacyAccounts((_, { ok }) => ok([]));

  // Return the user's DotNS username. Disclosing it requires consent, gated by
  // the per-product `GetUserId` permission. Returns `NotConnected` if no
  // account is signed in, and `PermissionDenied` if the permission has not been
  // granted explicitly.
  container.handleGetUserId((_, { ok, err }) => {
    const state = getAuthState();
    if (state.status !== "authenticated") {
      return errAsync(new GetUserIdErr.NotConnected(undefined));
    }
    const primaryUsername =
      state.identity?.fullUsername ?? state.identity?.liteUsername;
    if (primaryUsername === undefined || primaryUsername === "") {
      return errAsync(
        new GetUserIdErr.Unknown({
          reason: "No primary username for this session",
        }),
      );
    }
    return promptCachedSubmitPermission(label, "GetUserId").andThen(
      (granted) =>
        granted
          ? ok({ primaryUsername })
          : err(new GetUserIdErr.PermissionDenied(undefined)),
    );
  });

  // Products can trigger the host login flow. `requestLogin` dispatches a DOM
  // event that the topbar listens for (it owns the QR modal), and resolves once
  // the auth state settles.
  container.handleRequestLogin((reason, { ok }) => {
    return fromPromise(
      requestLogin(reason, label),
      (e) =>
        new LoginErr.Unknown({
          reason: e instanceof Error ? e.message : "Login flow failed",
        }),
    ).andThen((result) => ok(result));
  });

  container.handleAccountConnectionStatusSubscribe((_, send) => {
    return subscribeSession((session) => {
      send(session ? "connected" : "disconnected");
    });
  });

  container.handleAccountGetAlias((productAccountId, { err }) =>
    aliasLimiter.schedule(() => {
      const session = getSession();
      if (!session) {
        return err(new RequestCredentialsErr.NotConnected(undefined));
      }

      if (!labelAcceptsIdentifier(label, productAccountId[0])) {
        return err(new RequestCredentialsErr.DomainNotValid(undefined));
      }

      const identifier = labelToProductIdentifier(label);
      const isOwnDomain = identifier === productAccountId[0];

      if (isOwnDomain) {
        return session
          .getRingVrfAlias(productAccountId, identifier)
          .mapErr(
            (error) =>
              new RequestCredentialsErr.Unknown({ reason: error.message }),
          );
      }

      return fromPromise(
        showAliasPermissionModal(identifier, productAccountId[0]),
        () => new RequestCredentialsErr.Rejected(undefined),
      ).andThen(() =>
        session
          .getRingVrfAlias(productAccountId, identifier)
          .mapErr(
            (error) =>
              new RequestCredentialsErr.Unknown({ reason: error.message }),
          ),
      );
    }),
  );

  container.handleSignPayload((payload, { ok, err }) =>
    queueWalletFlow(() => {
      log.warn(`[${label}] handleSignPayload invoked:`, {
        account: payload.account,
        genesisHash: payload.payload.genesisHash,
        method: payload.payload.method.slice(0, 40) + "...",
      });

      if (!isProductAccountValid(label, payload.account[0])) {
        log.warn(
          `[${label}] handleSignPayload — invalid account[0]=${payload.account[0]}`,
        );
        return errAsync(new SigningErr.PermissionDenied(undefined));
      }

      return promptCachedSubmitPermission(label, "ChainSubmit").andThen(
        (granted) => {
          if (!granted) {
            log.warn(`[${label}] handleSignPayload — ChainSubmit not granted`);
            return err(new SigningErr.PermissionDenied(undefined));
          }
          const session = getSession();
          if (!session) {
            log.error(`[${label}] handleSignPayload — no session, rejecting`);
            return err(new SigningErr.Rejected(undefined));
          }

          return fromPromise(
            showSignPayloadModal(
              session,
              payload.payload,
              label,
              payload.account,
            ),
            (e) => e as never,
          )
            .andThen((result) => {
              log.warn(`[${label}] handleSignPayload — resolved OK`);
              return ok({
                signature: result.signature,
                signedTransaction: result.signedTransaction,
              });
            })
            .orElse((e) => {
              log.warn(`[${label}] handleSignPayload — rejected:`, e);
              return err(e);
            });
        },
      );
    }),
  );

  container.handleSignRaw((payload, { ok, err }) =>
    queueWalletFlow(() => {
      log.warn(`[${label}] handleSignRaw invoked:`, {
        account: payload.account,
        dataTag: payload.payload.tag,
      });

      if (!isProductAccountValid(label, payload.account[0])) {
        log.warn(
          `[${label}] handleSignRaw — invalid account[0]=${payload.account[0]}`,
        );
        return errAsync(new SigningErr.PermissionDenied(undefined));
      }

      const session = getSession();
      if (!session) {
        log.error(`[${label}] handleSignRaw — no session, rejecting`);
        return errAsync(new SigningErr.Rejected(undefined));
      }

      return fromPromise(
        showSignRawModal(session, payload.payload, label, payload.account),
        (e) => e as never,
      )
        .andThen((result) => {
          log.warn(`[${label}] handleSignRaw — resolved OK`);
          return ok({
            signature: result.signature,
            signedTransaction: result.signedTransaction,
          });
        })
        .orElse((e) => {
          log.warn(`[${label}] handleSignRaw — rejected:`, e);
          return err(e);
        });
    }),
  );

  // host-api 0.7.9 delegates extrinsic construction to the wallet via
  // host_create_transaction. We forward the typed payload to the paired
  // mobile app and return the signed extrinsic bytes the wallet builds.
  container.handleCreateTransaction((payload, { ok, err }) =>
    queueWalletFlow(() => {
      log.warn(`[${label}] handleCreateTransaction invoked:`, {
        signer: payload.signer,
        genesisHash: toHex(payload.genesisHash),
        callDataLen: payload.callData.length,
        extensions: payload.extensions.map((e) => e.id),
        txExtVersion: payload.txExtVersion,
      });

      if (!isProductAccountValid(label, payload.signer[0])) {
        log.warn(
          `[${label}] handleCreateTransaction — invalid signer[0]=${payload.signer[0]}`,
        );
        return errAsync(new CreateTransactionErr.PermissionDenied());
      }

      return promptCachedSubmitPermission(label, "ChainSubmit").andThen(
        (granted) => {
          if (!granted) {
            log.warn(
              `[${label}] handleCreateTransaction — ChainSubmit not granted`,
            );
            return err(new CreateTransactionErr.PermissionDenied());
          }
          const session = getSession();
          if (!session) {
            log.error(
              `[${label}] handleCreateTransaction — no session, rejecting`,
            );
            return err(new CreateTransactionErr.Rejected());
          }

          return fromPromise(
            showCreateTransactionModal(session, payload, label),
            (e) => e as never,
          )
            .andThen((signedTx) => {
              log.warn(`[${label}] handleCreateTransaction — resolved OK`);
              return ok(signedTx);
            })
            .orElse((e) => {
              log.warn(`[${label}] handleCreateTransaction — rejected:`, e);
              return err(e);
            });
        },
      );
    }),
  );

  // Legacy-account signing wires. Re-derive the same `(session, identifier, 0)`
  // public key, SS58-encode it, and require it equals the product-supplied
  // `signer: string` before opening the regular signing modal with a synthetic
  // `[identifier, 0]` tuple. Mirrors the desktop host's wire-up at
  // browser/src/widgets/ProductContainerBinding/integrations/signing.tsx.
  container.handleSignPayloadWithLegacyAccount((payload, { ok, err }) =>
    queueWalletFlow(() => {
      log.warn(`[${label}] handleSignPayloadWithLegacyAccount invoked:`, {
        signer: payload.signer,
        genesisHash: payload.payload.genesisHash,
        method: payload.payload.method.slice(0, 40) + "...",
      });

      const session = getSession();
      if (!session) {
        log.error(
          `[${label}] handleSignPayloadWithLegacyAccount — no session, rejecting`,
        );
        return errAsync(new SigningErr.Rejected(undefined));
      }

      const identifier = labelToProductIdentifier(label);
      const derivedPk = deriveProductPublicKey(
        session.rootAccountId,
        identifier,
        0,
      );
      const derivedAddress = productPublicKeyToAddress(derivedPk);
      if (derivedAddress !== payload.signer) {
        log.warn(
          `[${label}] handleSignPayloadWithLegacyAccount — signer mismatch (expected ${derivedAddress}, got ${payload.signer})`,
        );
        return errAsync(
          new SigningErr.Unknown({
            reason: "Account can't be derived from product account id",
          }),
        );
      }

      return promptCachedSubmitPermission(label, "ChainSubmit").andThen(
        (granted) => {
          if (!granted) {
            log.warn(
              `[${label}] handleSignPayloadWithLegacyAccount — ChainSubmit not granted`,
            );
            return err(new SigningErr.PermissionDenied(undefined));
          }
          return fromPromise(
            showSignPayloadModal(session, payload.payload, label, [
              identifier,
              0,
            ]),
            (e) => e as never,
          )
            .andThen((result) => {
              log.warn(
                `[${label}] handleSignPayloadWithLegacyAccount — resolved OK`,
              );
              return ok({
                signature: result.signature,
                signedTransaction: result.signedTransaction,
              });
            })
            .orElse((e) => {
              log.warn(
                `[${label}] handleSignPayloadWithLegacyAccount — rejected:`,
                e,
              );
              return err(e);
            });
        },
      );
    }),
  );

  container.handleSignRawWithLegacyAccount((payload, { ok, err }) =>
    queueWalletFlow(() => {
      log.warn(`[${label}] handleSignRawWithLegacyAccount invoked:`, {
        signer: payload.signer,
        dataTag: payload.payload.tag,
      });

      const session = getSession();
      if (!session) {
        log.error(
          `[${label}] handleSignRawWithLegacyAccount — no session, rejecting`,
        );
        return errAsync(new SigningErr.Rejected(undefined));
      }

      const identifier = labelToProductIdentifier(label);
      const derivedPk = deriveProductPublicKey(
        session.rootAccountId,
        identifier,
        0,
      );
      const derivedAddress = productPublicKeyToAddress(derivedPk);
      if (derivedAddress !== payload.signer) {
        log.warn(
          `[${label}] handleSignRawWithLegacyAccount — signer mismatch (expected ${derivedAddress}, got ${payload.signer})`,
        );
        return errAsync(
          new SigningErr.Unknown({
            reason: "Account can't be derived from product account id",
          }),
        );
      }

      return fromPromise(
        showSignRawModal(session, payload.payload, label, [identifier, 0]),
        (e) => e as never,
      )
        .andThen((result) => {
          log.warn(`[${label}] handleSignRawWithLegacyAccount — resolved OK`);
          return ok({
            signature: result.signature,
            signedTransaction: result.signedTransaction,
          });
        })
        .orElse((e) => {
          log.warn(`[${label}] handleSignRawWithLegacyAccount — rejected:`, e);
          return err(e);
        });
    }),
  );

  // Legacy-account create-transaction. The host-papp SSO message only carries
  // the product-account flavor, so we re-route the request through the same
  // wallet flow using a synthetic `[identifier, 0]` tuple. Mirrors the trust
  // model of `handleSignPayloadWithLegacyAccount` above. `payload.signer` is
  // the raw 32-byte public key (codec is `AccountId = Bytes(32)`).
  container.handleCreateTransactionWithLegacyAccount((payload, { ok, err }) =>
    queueWalletFlow(() => {
      log.warn(`[${label}] handleCreateTransactionWithLegacyAccount invoked:`, {
        signerHex: toHex(payload.signer),
        genesisHash: toHex(payload.genesisHash),
        callDataLen: payload.callData.length,
        extensions: payload.extensions.map((e) => e.id),
        txExtVersion: payload.txExtVersion,
      });

      const session = getSession();
      if (!session) {
        log.error(
          `[${label}] handleCreateTransactionWithLegacyAccount — no session, rejecting`,
        );
        return errAsync(new CreateTransactionErr.Rejected());
      }

      const identifier = labelToProductIdentifier(label);
      const derivedPk = deriveProductPublicKey(
        session.rootAccountId,
        identifier,
        0,
      );
      if (toHex(derivedPk) !== toHex(payload.signer)) {
        log.warn(
          `[${label}] handleCreateTransactionWithLegacyAccount — signer mismatch (expected ${productPublicKeyToAddress(derivedPk)}, got pk=${toHex(payload.signer)})`,
        );
        return errAsync(
          new CreateTransactionErr.Unknown({
            reason: "Account can't be derived from product account id",
          }),
        );
      }

      return promptCachedSubmitPermission(label, "ChainSubmit").andThen(
        (granted) => {
          if (!granted) {
            log.warn(
              `[${label}] handleCreateTransactionWithLegacyAccount — ChainSubmit not granted`,
            );
            return err(new CreateTransactionErr.PermissionDenied());
          }
          const productPayload: ContainerCreateTransactionPayload = {
            signer: [identifier, 0],
            genesisHash: payload.genesisHash,
            callData: payload.callData,
            extensions: payload.extensions,
            txExtVersion: payload.txExtVersion,
          };
          return fromPromise(
            showCreateTransactionModal(session, productPayload, label),
            (e) => e as never,
          )
            .andThen((signedTx) => {
              log.warn(
                `[${label}] handleCreateTransactionWithLegacyAccount — resolved OK`,
              );
              return ok(signedTx);
            })
            .orElse((e) => {
              log.warn(
                `[${label}] handleCreateTransactionWithLegacyAccount — rejected:`,
                e,
              );
              return err(e);
            });
        },
      );
    }),
  );

  container.handleRequestResourceAllocation((resources, { ok, err }) =>
    queueWalletFlow(() => {
      log.warn(`[${label}] handleRequestResourceAllocation invoked:`, {
        resources: resources.map((r) => r.tag),
      });

      const session = getSession();
      if (!session) {
        log.error(
          `[${label}] handleRequestResourceAllocation — no session, rejecting`,
        );
        return errAsync(
          new ResourceAllocationErr.Unknown({ reason: "No active session" }),
        );
      }

      return fromPromise(
        showAllocationRequestModal(label, resources, async () => {
          const outcomes = await session
            .requestResourceAllocation({
              callingProductId: labelToProductIdentifier(label),
              // The product-facing host-api protocol spells this variant
              // `BulletinAllowance`, but papp's host-to-mobile resource
              // allocation codec still uses the legacy `BulletInAllowance`.
              // Translate on the way in so the scale codec finds the variant.
              resources: resources.map((r) =>
                r.tag === "BulletinAllowance"
                  ? { tag: "BulletInAllowance" as const, value: undefined }
                  : r,
              ),
              onExisting: "Increase",
            })
            .match(
              (o) => o,
              (e) => {
                throw e;
              },
            );
          // Strip secret payload from Allocated outcomes before returning to product.
          return outcomes.map((o) =>
            o.tag === "Allocated"
              ? ({ tag: "Allocated", value: undefined } as const)
              : o,
          );
        }),
        (e) =>
          new ResourceAllocationErr.Unknown({
            reason: e instanceof Error ? e.message : String(e),
          }),
      )
        .andThen((outcomes) => {
          log.warn(`[${label}] handleRequestResourceAllocation — resolved OK`);
          return ok(outcomes);
        })
        .orElse((e) => {
          log.warn(`[${label}] handleRequestResourceAllocation — rejected:`, e);
          return err(e);
        });
    }),
  );

  container.handleLocalStorageRead((key, { ok, err }) => {
    try {
      const raw = localStorage.getItem(storagePrefix + key);
      if (raw === null) {
        return ok(undefined);
      }
      const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
      return ok(bytes);
    } catch {
      return err(
        new StorageErr.Unknown({ reason: "Failed to read from storage" }),
      );
    }
  });

  container.handleLocalStorageWrite(([key, value], { ok, err }) => {
    try {
      const b64 = btoa(String.fromCharCode(...value));
      localStorage.setItem(storagePrefix + key, b64);
      return ok(undefined);
    } catch {
      return err(
        new StorageErr.Unknown({ reason: "Failed to write to storage" }),
      );
    }
  });

  container.handleLocalStorageClear((key, { ok, err }) => {
    try {
      localStorage.removeItem(storagePrefix + key);
      return ok(undefined);
    } catch {
      return err(new StorageErr.Unknown({ reason: "Failed to clear storage" }));
    }
  });

  // Deterministic 32-byte entropy scoped to the calling product and a
  // caller-chosen key. Uses the wallet-provided `rootEntropySource` so the
  // output stays stable across re-pairings instead of churning with each
  // session's statement-account secret.
  container.handleDeriveEntropy((key, { ok, err }) => {
    const session = getSession();
    if (!session) {
      return err(new DeriveEntropyErr.Unknown({ reason: "Not connected" }));
    }
    try {
      const entropy = deriveProductEntropyFromSource(
        session.rootEntropySource,
        `${label}.dot`,
        key,
      );
      return ok(entropy);
    } catch (e) {
      return err(
        new DeriveEntropyErr.Unknown({
          reason: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  });

  container.handleNavigateTo((url, { ok }) => {
    const dotUrl = dotNsUrl.parseDotNsDomain(url);

    if (dotUrl && dotNsUrl.isDotDomain(dotUrl.identifier)) {
      // .dot domain (including polkadot:// scheme)
      window.open(
        buildDotTargetUrl(
          identifierToLabel(dotUrl.identifier),
          dotUrl.pathname,
        ),
        "_blank",
      );
    } else {
      const localhostUrl = dotNsUrl.parseLocalhostUrl(url);
      if (localhostUrl) {
        // localhost product: wrap in host URL
        const suffix = localhostUrl.pathname ? "/" + localhostUrl.pathname : "";
        window.open(
          `${getHostOrigin()}/${localhostUrl.host}${suffix}`,
          "_blank",
        );
      } else {
        window.open(dotNsUrl.normalizeUrl(url), "_blank");
      }
    }

    return ok(undefined);
  });

  container.handleDevicePermission((permission, { ok }) =>
    permissionLimiter.schedule(() => {
      // Notifications: tri-state, no iframe reload, silent on denied.
      // (No Permissions Policy directive maps to Notifications, so granting
      // it doesn't change the iframe `allow` attribute. And a denied user
      // explicitly chose silence. Surfacing a "your notifications are
      // blocked" toast would defeat the point.)
      if (permission === "Notifications") {
        const status = getPermissionStatus(label, "Notifications");
        if (status === "granted") {
          return ok(true);
        }
        if (status === "denied") {
          return ok(false);
        }

        return fromPromise(
          showPermissionRequestModal(label, "Notifications").then(() => {
            setPermissionStatus(label, "Notifications", "granted");
          }),
          () => "denied" as const,
        )
          .map(() => true)
          .orElse(() => {
            setPermissionStatus(label, "Notifications", "denied");
            return ok(false);
          });
      }

      // OpenUrl has no host-level enforcement point on the web (cross-origin
      // navigation happens via anchor or window.open). Auto-grant rather than
      // show a modal whose "Deny" button can't be honoured.
      if (!isEnforceableDevicePermission(permission)) {
        return ok(true);
      }

      const status = getPermissionStatus(label, permission);

      if (status === "granted") {
        return ok(true);
      }

      if (status === "denied") {
        showNotification({
          label: `${label}.dot`,
          text: `${permission} access is blocked. Use the permissions menu in the top bar to change this.`,
          dismissMs: 6000,
          browserNotification: false,
        });
        return ok(false);
      }

      // status === 'ask': show consent modal
      return fromPromise(
        showPermissionRequestModal(label, permission).then(() => {
          setPermissionStatus(label, permission, "granted");
          // Defer the reload to the next event loop tick so the
          // container can finish sending the response before being
          // disposed. Without this, cleanup() runs synchronously
          // inside the dispatch, disposing the transport mid-response.
          setTimeout(() => {
            window.dispatchEvent(
              new CustomEvent("dotli:device-permission-changed", {
                detail: { label, permission },
              }),
            );
          }, 0);
        }),
        () => "denied" as const,
      )
        .map(() => {
          // User allowed, but the iframe reloads, so return false for now
          return false;
        })
        .orElse(() => {
          // User denied (rejected promise) or dialog dismissed
          setPermissionStatus(label, permission, "denied");
          return ok(false);
        });
    }),
  );

  container.handlePermission((request, { ok }) =>
    permissionLimiter.schedule(() => {
      log.warn(
        `[${label}] remote_permission incoming: tag=${request.tag}, value=${JSON.stringify(request.value)}`,
      );

      if (request.tag in CACHED_SUBMIT_PERMISSIONS) {
        return promptCachedSubmitPermission(
          label,
          request.tag as keyof typeof CACHED_SUBMIT_PERMISSIONS,
        );
      }

      // Remote (HTTP/WS) and WebRTC are auto-granted: the browser can't
      // reliably intercept fetch/XHR/WebSocket from inside an iframe, and
      // WebRTC is already gated by the iframe `allow` attribute. Any
      // future unknown wire tag lands here too and auto-grants.
      log.warn(`[${label}] remote_permission ${request.tag} auto-granted`);
      return ok(true);
    }),
  );

  container.handlePushNotification(
    ({ text, deeplink, scheduledAt }, { ok }) => {
      log.warn(`[${label}] Push notification:`, {
        text,
        deeplink,
        scheduledAt,
      });
      const scheduledAtMs =
        scheduledAt === undefined ? null : Number(scheduledAt);
      return fromPromise(
        scheduleNotification({
          productId: label,
          title: label,
          text,
          deeplink: deeplink ?? null,
          scheduledAt: scheduledAtMs,
        }),
        (e) =>
          new PushNotificationError.Unknown({
            reason: e instanceof Error ? e.message : String(e),
          }),
      ).andThen((result) => {
        if (!result.ok) {
          // The only failure the scheduler reports is the per-product cap.
          return errAsync(new PushNotificationError.ScheduleLimitReached());
        }
        if (result.immediate) {
          showNotification({
            text,
            deeplink: deeplink ?? undefined,
            label,
          });
        }
        return ok(result.id);
      });
    },
  );

  container.handlePushNotificationCancel((id, { ok }) =>
    fromPromise(
      cancelNotification(label, id),
      (e) =>
        new GenericError({
          reason: e instanceof Error ? e.message : String(e),
        }),
    ).andThen(() => ok(undefined)),
  );

  //
  // Handlers resolve getStatementStore() lazily (at call time, not setup time)
  // because initAuth() is lazy-loaded and may not have run yet.

  container.handleStatementStoreSubscribe((topicFilter, send) => {
    let innerUnsub: (() => void) | null = null;
    let cancelled = false;

    function startSubscription(store: StatementStoreAdapter): void {
      if (cancelled) {
        return;
      }
      // Bridge the wire-side tagged union to the adapter's discriminator-free
      // `{ matchAll }`/`{ matchAny }` shape.
      const topics = topicFilter.value;
      const filter =
        topicFilter.tag === "MatchAny"
          ? { matchAny: topics }
          : { matchAll: topics };
      log.warn(`[${label}] Statement store subscribe, topics:`, topics.length);
      innerUnsub = store.subscribeStatements(filter, (page) => {
        log.warn(
          `[${label}] Statement store received ${String(page.statements.length)} statements (isComplete=${String(page.isComplete)})`,
        );
        const signed = page.statements.filter(
          (s): s is SignedStatement => s.proof !== undefined,
        );
        if (signed.length > 0) {
          send({
            statements: signed.map(mapSdkSignedStatement),
            isComplete: page.isComplete,
          });
        }
      });
    }

    const store = getStatementStore();
    if (store) {
      startSubscription(store);
    } else {
      log.warn(
        `[${label}] Statement store subscribe — store not ready, waiting…`,
      );
      void onStatementStoreReady().then(startSubscription);
    }

    return () => {
      cancelled = true;
      innerUnsub?.();
    };
  });

  container.handleStatementStoreSubmit((statement) =>
    submitLimiter.schedule(() => {
      const store = getStatementStore();
      if (!store) {
        return errAsync(
          new GenericError({ reason: "Statement store not initialized" }),
        );
      }
      return store
        .submitStatement(mapFromHostSignedStatement(statement))
        .map(() => undefined)
        .mapErr((e: Error) => new GenericError({ reason: e.message }));
    }),
  );

  // ProductAccountId ([dotNsIdentifier, derivationIndex]) is intentionally
  // unused. The proof is always signed with the root session key because only
  // the session account has a network allowance (quota) on People Chain.
  // Derived product accounts are not registered and cannot submit statements.
  container.handleStatementStoreCreateProof(([, statement], { err }) => {
    const session = getSession();
    if (!session) {
      return err(new StatementProofErr.UnableToSign());
    }

    return fromPromise(readSessionSecret(session.id), (e) =>
      e instanceof Error ? e : new Error(String(e)),
    )
      .mapErr((e) => new StatementProofErr.Unknown({ reason: e.message }))
      .andThen((secret) =>
        secret
          ? fromPromise(
              Promise.resolve(createSr25519Prover(secret)),
              () => new StatementProofErr.UnableToSign(),
            )
          : err(new StatementProofErr.UnableToSign()),
      )
      .andThen((prover) =>
        prover
          .generateMessageProof(mapFromHostStatement(statement))
          .mapErr((e) => new StatementProofErr.Unknown({ reason: e.message })),
      )
      .map((signed) => mapSdkProof(signed.proof));
  });

  // Submit stores data on Bulletin via TransactionStorage.store(), signed
  // with the user's wallet-authorized allowance slot account, and returns
  // the Blake2b-256 hash key.
  // Lookup retrieves data by hash via Helia P2P (IPFS gateway fallback).

  const preimageCache = new Map<string, Uint8Array>();

  container.handlePreimageSubmit((value) =>
    preimageLimiter.schedule(() => {
      log.warn(
        `[${label}] Preimage submit request, size: ${String(value.byteLength)}`,
      );

      return fromPromise(showPreimageSubmitModal(value.byteLength), (e) =>
        e instanceof Error ? e.message : "User denied preimage submit",
      )
        .andThen(() => {
          const session = getSession();
          if (!session) {
            return errAsync("No active session");
          }
          const allowance = getAllowanceService();
          if (!allowance) {
            return errAsync("Allowance service not initialized");
          }
          // Slot-account keys are cached per (session, product, resource) in
          // host-papp's AllowanceRepository, so only the first submit
          // round-trips to the wallet.
          return allowance
            .getBulletinSigner(session.id, labelToProductIdentifier(label))
            .mapErr((e) => e.message);
        })
        .andThen((signer) => {
          const key = computePreimageKey(value);
          return fromPromise(submitPreimageAsUser(value, signer), (e) =>
            e instanceof Error ? e.message : String(e),
          ).map(() => {
            preimageCache.set(key, value);
            log.warn(`[${label}] Preimage stored, key: ${key}`);
            return key;
          });
        })
        .mapErr((reason) => {
          // Surface the real failure reason on the host console. The
          // product-side only receives the opaque `PreimageSubmitErr.Unknown`
          // class, so without this log there is no way to diagnose why a
          // submit got rejected.
          log.error(`[${label}] Preimage submit failed: ${reason}`);
          return new PreimageSubmitErr.Unknown({ reason });
        });
    }),
  );

  // Preimage lookup subscribe contract:
  //   - Caller (sandboxed app) requests a preimage by key. The lookup runs
  //     against the user's chosen content backend exclusively, no crossover.
  //   - We poll at POLL_INTERVAL_MS until cached or the caller drops the
  //     subscription.
  //   - A miss ("not found yet") and a backend throw (Helia/gateway error)
  //     are both logged and polling continues. The subscription never
  //     self-interrupts: the propagation time for a valid preimage can be
  //     arbitrary, and cutting the subscription on "a few misses" made slow
  //     but healthy chains look like transport failure to the caller.
  //   - This is not a silent retry across providers. The user-selected
  //     backend is the only backend dialed. Failures stay attributable.
  container.handlePreimageLookupSubscribe((key, send, _interrupt) => {
    log.warn(`[${label}] Preimage lookup subscribe, key: ${key}`);

    let stopped = false;

    // Check local cache first
    const cached = preimageCache.get(key);
    if (cached) {
      send(cached);
    } else {
      send(null);
    }

    // Poll: use whichever content backend the user selected.
    const poll = async (): Promise<void> => {
      if (stopped) {
        return;
      }

      // Re-check cache (may have been populated by a submit)
      const cachedValue = preimageCache.get(key);
      if (cachedValue) {
        send(cachedValue);
        return;
      }

      const cid = hashToCid(key);
      const cidString = cid.toString();

      // Honor the user's backend choice. No silent smoldot-to-gateway
      // crossover. A bitswap lookup failure is a bitswap failure. A
      // gateway failure is a gateway failure. We log and keep polling.
      // The caller unsubscribes when it's done waiting.
      const backend = getBackend();
      try {
        if (backend === "rpc-gateway") {
          const result = await fetchFromIpfs(cidString);
          if (result.data.length > 0) {
            preimageCache.set(key, result.data);
            send(result.data);
            return;
          }
        } else {
          // smoldot-direct or smoldot-shared-worker: fetch via the protocol
          // iframe's smoldot using `bitswap_v1_get`. The host helper sends
          // it through the existing chainConnect/chainSend bridge and
          // handles the -32811/-32812 retry envelope.
          const { bitswapGet } = await import("./bulletin-bitswap");
          const data = await bitswapGet(cidString);
          if (data.length > 0) {
            preimageCache.set(key, data);
            send(data);
            return;
          }
        }
      } catch (err) {
        log.warn(`[${label}] preimage lookup via ${backend} failed:`, err);
      }
    };

    const POLL_INTERVAL_MS = 10_000;
    const intervalId = setInterval(() => void poll(), POLL_INTERVAL_MS);
    const initialTimeoutId = setTimeout(() => void poll(), 1000);

    return () => {
      stopped = true;
      clearInterval(intervalId);
      clearTimeout(initialTimeoutId);
    };
  });

  container.handleThemeSubscribe((_params, send) => {
    const readTheme = () =>
      ({
        name: { tag: "Default", value: undefined },
        variant:
          document.documentElement.getAttribute("data-theme") === "light"
            ? "Light"
            : "Dark",
      }) as const;

    send(readTheme());

    const listener = (): void => {
      send(readTheme());
    };
    window.addEventListener("dotli:theme-changed", listener);

    return () => {
      window.removeEventListener("dotli:theme-changed", listener);
    };
  });

  // dot.li does not own a payment rail yet. Register explicit
  // "not implemented" responses so products see a specific reason
  // rather than a generic transport error, and subscription starts
  // fail fast via `interrupt` with a typed error.
  container.handlePaymentBalanceSubscribe((_, _send, interrupt) => {
    interrupt(new PaymentBalanceErr.PermissionDenied());
    return NOOP;
  });

  container.handlePaymentTopUp((_, { err }) => {
    return err(
      new PaymentTopUpErr.Unknown({ reason: PAYMENTS_NOT_IMPLEMENTED }),
    );
  });

  container.handlePaymentRequest((_, { err }) => {
    return err(
      new PaymentRequestErr.Unknown({ reason: PAYMENTS_NOT_IMPLEMENTED }),
    );
  });

  container.handlePaymentStatusSubscribe((_, _send, interrupt) => {
    interrupt(
      new PaymentStatusErr.Unknown({ reason: PAYMENTS_NOT_IMPLEMENTED }),
    );
    return NOOP;
  });

  return () => {
    aliasLimiter.destroy();
    permissionLimiter.destroy();
    submitLimiter.destroy();
    preimageLimiter.destroy();
  };
}

const PAYMENTS_NOT_IMPLEMENTED = "Payments are not supported in dot.li";
const NOOP: VoidFunction = () => undefined;

// Each submit-style wire tag caches a per-product decision in
// localStorage under the `storageKey` below, prompting once via
// `showPermissionRequestModal` when the cache is empty. `Remote`
// intentionally prompts every call (the domain-pattern list is
// dynamic). `WebRTC` is auto-granted (browser gates it via the
// iframe `allow` attribute).

const CACHED_SUBMIT_PERMISSIONS = {
  ChainSubmit: { storageKey: "ChainSubmit", label: "Transaction signing" },
  PreimageSubmit: { storageKey: "PreimageSubmit", label: "Preimage submit" },
  StatementSubmit: { storageKey: "StatementSubmit", label: "Statement submit" },
  GetUserId: { storageKey: "GetUserId", label: "Reveal Username" },
} satisfies Record<string, { storageKey: PermissionName; label: string }>;

function promptCachedSubmitPermission(
  productLabel: string,
  tag: keyof typeof CACHED_SUBMIT_PERMISSIONS,
): ResultAsync<boolean, never> {
  const { storageKey, label: humanLabel } = CACHED_SUBMIT_PERMISSIONS[tag];
  const status = getPermissionStatus(productLabel, storageKey);
  log.warn(`[${productLabel}] remote_permission ${tag}, status=${status}`);

  if (status === "granted") {
    return okAsync(true);
  }

  if (status === "denied") {
    log.warn(
      `[${productLabel}] ${tag} cached as denied — toggle the permission in the top-bar menu to re-prompt`,
    );
    showNotification({
      label: `${productLabel}.dot`,
      text: `${humanLabel} is blocked. Use the permissions menu in the top bar to change this.`,
      dismissMs: 6000,
      browserNotification: false,
    });
    return okAsync(false);
  }

  return fromPromise(
    showPermissionRequestModal(productLabel, storageKey).then(() => {
      setPermissionStatus(productLabel, storageKey, "granted");
      window.dispatchEvent(
        new CustomEvent("dotli:permission-changed", {
          detail: { label: productLabel },
        }),
      );
    }),
    () => "denied" as const,
  )
    .map(() => true)
    .orElse(() => {
      setPermissionStatus(productLabel, storageKey, "denied");
      return okAsync(false);
    });
}

/** Strip the `.dot` suffix to get the bare label (e.g. "mytestapp.dot" becomes "mytestapp"). */
function identifierToLabel(identifier: string): string {
  return identifier.slice(0, -".dot".length);
}

/** Build a full URL for a .dot product on the current environment. */
function buildDotTargetUrl(label: string, pathname: string): string {
  const suffix = pathname ? "/" + pathname : "";
  if (isLocalhost) {
    return `http://${label}.localhost:${window.location.port}${suffix}`;
  }
  return `${window.location.protocol}//${label}.${BASE_DOMAIN}${suffix}`;
}

/** Bare host origin without any product subdomain (e.g. `http://localhost:5173` or `https://dot.li`). */
function getHostOrigin(): string {
  if (isLocalhost) {
    return `http://localhost:${window.location.port}`;
  }
  return `${window.location.protocol}//${BASE_DOMAIN}`;
}

/** Check if a value is a Uint8Array (or cross-realm equivalent). */
function isUint8ArrayLike(data: unknown): data is Uint8Array {
  if (data instanceof Uint8Array) {
    return true;
  }
  if (typeof data !== "object" || data === null) {
    return false;
  }
  return (
    (data as { constructor: { name: string } }).constructor.name ===
    "Uint8Array"
  );
}

// Implements the same Provider interface as createIframeProvider
// but targets a captured Window reference (from event.source)
// instead of an HTMLIFrameElement.

function createWindowProvider(sourceWindow: Window): Provider {
  let disposed = false;
  const subscribers = new Set<(message: Uint8Array) => void>();

  const messageHandler = (event: MessageEvent): void => {
    if (disposed) {
      return;
    }
    if (event.source !== sourceWindow) {
      return;
    }
    if (!isUint8ArrayLike(event.data)) {
      return;
    }

    for (const subscriber of subscribers) {
      subscriber(event.data);
    }
  };

  window.addEventListener("message", messageHandler);

  return {
    logger: createDefaultLogger(),

    isCorrectEnvironment() {
      return true;
    },
    postMessage(message) {
      if (disposed) {
        return;
      }
      sourceWindow.postMessage(message, "*", [message.buffer]);
    },
    subscribe(callback) {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
    dispose() {
      disposed = true;
      subscribers.clear();
      window.removeEventListener("message", messageHandler);
    },
  };
}

// Listens for Uint8Array postMessage events from windows other
// than the primary iframe. When a new source is detected, creates
// a full bridge (Provider + Container + handlers) for that window.
//
// This enables nested dApps (dApp-in-dApp) to communicate with
// the HOST, since all dApps send to window.top regardless of depth.

export function setupNestedBridgeDetector(
  primaryIframe: HTMLIFrameElement,
  label: string,
): () => void {
  const knownWindows = new Set<MessageEventSource>();
  const disposers: (() => void)[] = [];

  function messageHandler(event: MessageEvent): void {
    // Only handle protocol messages (Uint8Array)
    if (!isUint8ArrayLike(event.data)) {
      return;
    }
    // Skip messages from the primary iframe (handled by its own bridge)
    if (event.source === primaryIframe.contentWindow) {
      return;
    }
    // Skip messages from ourselves
    if (event.source === window) {
      return;
    }
    // Must have a source
    if (event.source === null) {
      return;
    }
    // Skip already-known nested windows
    if (knownWindows.has(event.source)) {
      return;
    }

    // Validate origin: only allow *.dot.li and *.localhost origins
    try {
      const url = new URL(event.origin);
      const h = url.hostname;
      const allowed =
        h.endsWith(`.${BASE_DOMAIN}`) ||
        h === BASE_DOMAIN ||
        h === "localhost" ||
        h.endsWith(".localhost");
      if (!allowed) {
        log.warn(
          `[dot.li] Rejected nested bridge from disallowed origin: ${event.origin}`,
        );
        return;
      }
    } catch {
      return;
    }

    // Cap the number of nested bridges
    if (knownWindows.size >= MAX_NESTED_BRIDGES) {
      log.warn(
        `[dot.li] Nested bridge limit reached (max ${String(MAX_NESTED_BRIDGES)}), ignoring`,
      );
      return;
    }

    // New nested dApp detected
    knownWindows.add(event.source);
    const nestedId = String(knownWindows.size);
    log.warn(`[dot.li] Nested dApp #${nestedId} detected, creating bridge`);

    const provider = createWindowProvider(event.source as Window);
    const productId = `${label}:nested-${nestedId}`;
    emitDotliDebugEvent({
      layer: "bridge",
      event: "nested_detected",
      flowId:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `bridge-${String(Date.now())}-${nestedId}`,
      timestamp: Date.now(),
      payload: { label, productId, nestedIndex: knownWindows.size },
    });
    const container = createContainer(provider, { productId });
    const nestedPrefix = `dotli:${label}:nested-${nestedId}:`;
    const teardown = wireContainerHandlers(container, label, nestedPrefix);

    disposers.push(() => {
      teardown();
      container.dispose();
    });
  }

  window.addEventListener("message", messageHandler);

  return () => {
    window.removeEventListener("message", messageHandler);
    for (const dispose of disposers) {
      dispose();
    }
    knownWindows.clear();
    disposers.length = 0;
  };
}

/**
 * Set up the host container for an iframe displaying a .dot SPA.
 *
 * Creates a postMessage-based provider, wires up all handlers
 * (accounts, signing, localStorage, etc.) and loads the URL in the iframe.
 *
 * Returns a dispose function to tear down the container.
 */
export function setupContainer(
  iframe: HTMLIFrameElement,
  blobUrl: string,
  label: string,
  bridgeFlowId?: string,
): () => void {
  const baseProvider = createIframeProvider({ iframe, url: blobUrl });
  const provider =
    bridgeFlowId !== undefined
      ? instrumentProvider(baseProvider, label, bridgeFlowId)
      : baseProvider;
  const container = createContainer(provider, { productId: label });
  const storagePrefix = `dotli:${label}:`;
  const teardown = wireContainerHandlers(container, label, storagePrefix);

  return () => {
    teardown();
    container.dispose();
  };
}

/**
 * Wrap a bridge Provider so the first inbound and first outbound
 * messages emit debug events. These anchor the often-long window
 * between `bridge:setup_ready` (handler registered) and the moment
 * the product iframe actually starts exchanging messages with the
 * host, during which the TrUAPI swimlane typically shows dozens to
 * hundreds of `host_handshake_request` retries with no corresponding
 * system-layer activity.
 */
function instrumentProvider(
  base: Provider,
  label: string,
  bridgeFlowId: string,
): Provider {
  let inboundEmitted = false;
  let outboundEmitted = false;
  return {
    ...base,
    postMessage(message) {
      if (!outboundEmitted) {
        outboundEmitted = true;
        emitDotliDebugEvent({
          layer: "bridge",
          event: "first_outbound",
          flowId: bridgeFlowId,
          timestamp: Date.now(),
          payload: { label, productId: label },
        });
        // Signal the main-thread monitor that it can stop. The
        // bridge is fully established.
        try {
          window.dispatchEvent(new CustomEvent("dotli:debug:bridge-ready"));
          // eslint-disable-next-line no-restricted-syntax -- dispatchEvent may throw in exotic environments; the debug monitor is best-effort.
        } catch {
          /* ignore: monitor just falls back to its duration cap */
        }
      }
      base.postMessage(message);
    },
    subscribe(callback) {
      return base.subscribe((message) => {
        if (!inboundEmitted) {
          inboundEmitted = true;
          emitDotliDebugEvent({
            layer: "bridge",
            event: "first_inbound",
            flowId: bridgeFlowId,
            timestamp: Date.now(),
            payload: { label, productId: label },
          });
        }
        callback(message);
      });
    },
  };
}
