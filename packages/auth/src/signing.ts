// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Signing confirmation modals for dot.li (vanilla DOM).
//
// Bridges host-container's `{ account, payload }` request to host-papp's
// `{ productAccountId, ...payload }` shape (host-api 0.7.6+). host-papp
// derives the signing secret on the wallet side from the product account
// tuple, so the host only forwards the tuple, with no address conversion or
// local derivation. The modal displays the tuple itself ("my-app.dot / 0")
// rather than a derived address. Computing the address would mean
// duplicating the wallet's derivation logic for display only.

import {
  CreateTransactionErr,
  SigningErr,
  enumValue,
  toHex,
} from "@novasamatech/host-api";
import { log } from "@dotli/shared/log";
import type { UserSession } from "@novasamatech/host-papp";
import { productPublicKeyToAddress } from "./account";

export interface SigningResult {
  signature: `0x${string}`;
  signedTransaction?: `0x${string}`;
}

export interface ContainerSignPayloadRequest {
  account: [string, number];
  payload: {
    blockHash: `0x${string}`;
    blockNumber: `0x${string}`;
    era: `0x${string}`;
    genesisHash: `0x${string}`;
    method: `0x${string}`;
    nonce: `0x${string}`;
    specVersion: `0x${string}`;
    tip: `0x${string}`;
    transactionVersion: `0x${string}`;
    signedExtensions: string[];
    version: number;
    assetId: `0x${string}` | undefined;
    metadataHash: `0x${string}` | undefined;
    mode: number | undefined;
    withSignedTransaction: boolean | undefined;
  };
}

export interface ContainerSignRawRequest {
  account: [string, number];
  payload:
    | { tag: "Bytes"; value: Uint8Array }
    | { tag: "Payload"; value: string };
}

export interface ContainerCreateTransactionPayload {
  signer: [string, number];
  genesisHash: Uint8Array;
  callData: Uint8Array;
  extensions: { id: string; extra: Uint8Array; additionalSigned: Uint8Array }[];
  txExtVersion: number;
}

/**
 * Legacy-account variant of `ContainerCreateTransactionPayload`. The signer is
 * a raw 32-byte public key (host-api `AccountId = Bytes(32)`) rather than the
 * `[dotNsIdentifier, derivationIndex]` product tuple, matching host-papp's
 * `LegacyTransaction = GenericTxPayloadV1(AccountId)`.
 */
export interface ContainerCreateTransactionLegacyPayload {
  signer: Uint8Array;
  genesisHash: Uint8Array;
  callData: Uint8Array;
  extensions: { id: string; extra: Uint8Array; additionalSigned: Uint8Array }[];
  txExtVersion: number;
}

/** Timeout for the wallet to respond (ms). Covers WS drops and unresponsive wallets. */
const SIGN_TIMEOUT_MS = 300_000; // 300 seconds

class SignTimeoutError extends Error {
  constructor() {
    super("Wallet did not respond in time — the connection may have dropped.");
    this.name = "SignTimeoutError";
  }
}

/** Race a thenable against a timeout. Clears the timer on settlement. */
function withTimeout<T>(thenable: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SignTimeoutError());
    }, ms);
    const cleanup = (): void => {
      clearTimeout(timer);
    };
    Promise.resolve(thenable).then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e: unknown) => {
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function createModalDOM(
  title: string,
  fields: { label: string; value: string; mono?: boolean }[],
): {
  backdrop: HTMLDivElement;
  signBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
} {
  const backdrop = document.createElement("div");
  backdrop.className = "signing-modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "signing-modal";

  const heading = document.createElement("h2");
  heading.textContent = title;
  modal.appendChild(heading);

  const fieldsContainer = document.createElement("div");
  fieldsContainer.className = "signing-fields";

  for (const field of fields) {
    const group = document.createElement("div");
    group.className = "signing-field";

    const label = document.createElement("div");
    label.className = "signing-field-label";
    label.textContent = field.label;
    group.appendChild(label);

    const value = document.createElement("div");
    value.className = "signing-field-value";
    if (field.mono === true) {
      value.classList.add("mono");
    }
    value.textContent = field.value;
    group.appendChild(value);

    fieldsContainer.appendChild(group);
  }
  modal.appendChild(fieldsContainer);

  const footer = document.createElement("div");
  footer.className = "signing-modal-footer";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "signing-btn-cancel";
  cancelBtn.textContent = "Cancel";
  footer.appendChild(cancelBtn);

  const signBtn = document.createElement("button");
  signBtn.className = "signing-btn-sign";
  signBtn.textContent = "Sign";
  footer.appendChild(signBtn);

  modal.appendChild(footer);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  return { backdrop, signBtn, cancelBtn };
}

function removeModal(backdrop: HTMLDivElement): void {
  backdrop.remove();
}

/**
 * Sign-payload modal.
 *
 * Receives the calling product's `[dotNsIdentifier, derivationIndex]` tuple,
 * which is what host-papp requires. The modal displays the tuple as the
 * "Signer" line. The wallet derives and signs with the matching secret on
 * its side.
 */
export function showSignPayloadModal(
  session: UserSession,
  payload: ContainerSignPayloadRequest["payload"],
  appLabel: string,
  productAccountId: [string, number],
): Promise<SigningResult> {
  return new Promise((resolve, reject) => {
    const signerLabel = `${productAccountId[0]} / ${String(productAccountId[1])}`;

    log.warn("[dot.li signing] signPayload request received:", {
      appLabel,
      productAccountId,
      genesisHash: payload.genesisHash,
      method: payload.method.slice(0, 40) + "...",
      mode: payload.mode,
      withSignedTransaction: payload.withSignedTransaction,
      metadataHash: payload.metadataHash,
      assetId: payload.assetId,
    });
    log.warn("[dot.li signing] session info:", {
      localAccountId: toHex(session.localAccount.accountId),
      sessionRoot: toHex(session.remoteAccount.accountId),
    });

    const fields: { label: string; value: string; mono?: boolean }[] = [
      { label: "App", value: appLabel },
      { label: "Signer", value: signerLabel },
      { label: "Genesis Hash", value: payload.genesisHash, mono: true },
      { label: "Call Data", value: payload.method, mono: true },
    ];

    const { backdrop, signBtn, cancelBtn } = createModalDOM(
      "Sign Transaction",
      fields,
    );

    cancelBtn.addEventListener("click", () => {
      log.warn("[dot.li signing] user cancelled signPayload");
      removeModal(backdrop);
      reject(new SigningErr.Rejected());
    });

    signBtn.addEventListener("click", () => {
      signBtn.disabled = true;
      signBtn.textContent = "Signing...";

      const signRequest = { productAccountId, ...payload };
      log.warn("[dot.li signing] dispatching signPayload to session:", {
        productAccountId,
        method: signRequest.method.slice(0, 40) + "...",
        mode: signRequest.mode,
        withSignedTransaction: signRequest.withSignedTransaction,
      });

      void withTimeout(session.signPayload(signRequest), SIGN_TIMEOUT_MS).then(
        (result) => {
          result.match(
            ({ signature, signedTransaction }) => {
              log.warn("[dot.li signing] signPayload SUCCESS:", {
                signature: toHex(signature).slice(0, 20) + "...",
                hasSignedTx: !!signedTransaction,
              });
              removeModal(backdrop);
              resolve({
                signature: toHex(signature),
                signedTransaction: signedTransaction
                  ? typeof signedTransaction === "string"
                    ? signedTransaction
                    : toHex(signedTransaction)
                  : undefined,
              });
            },
            (e) => {
              log.error("[dot.li signing] signPayload FAILED:", e.message, e);
              removeModal(backdrop);
              reject(new SigningErr.Unknown({ reason: e.message }));
            },
          );
        },
        (e: unknown) => {
          log.error("[dot.li signing] signPayload timed out:", e);
          removeModal(backdrop);
          const msg = e instanceof Error ? e.message : "Request timed out";
          reject(new SigningErr.Unknown({ reason: msg }));
        },
      );
    });
  });
}

/** Sign-raw counterpart of `showSignPayloadModal`; see that function for rationale. */
export function showSignRawModal(
  session: UserSession,
  data: ContainerSignRawRequest["payload"],
  appLabel: string,
  productAccountId: [string, number],
): Promise<SigningResult> {
  return new Promise((resolve, reject) => {
    const signerLabel = `${productAccountId[0]} / ${String(productAccountId[1])}`;
    const message = data.tag === "Payload" ? data.value : toHex(data.value);

    log.warn("[dot.li signing] signRaw request received:", {
      appLabel,
      productAccountId,
      dataTag: data.tag,
      message: message.slice(0, 80) + (message.length > 80 ? "..." : ""),
    });
    log.warn("[dot.li signing] session info:", {
      localAccountId: toHex(session.localAccount.accountId),
      sessionRoot: toHex(session.remoteAccount.accountId),
    });

    const fields: { label: string; value: string; mono?: boolean }[] = [
      { label: "App", value: appLabel },
      { label: "Signer", value: signerLabel },
      { label: "Message", value: message, mono: true },
    ];

    const { backdrop, signBtn, cancelBtn } = createModalDOM(
      "Sign Message",
      fields,
    );

    cancelBtn.addEventListener("click", () => {
      log.warn("[dot.li signing] user cancelled signRaw");
      removeModal(backdrop);
      reject(new SigningErr.Rejected());
    });

    signBtn.addEventListener("click", () => {
      signBtn.disabled = true;
      signBtn.textContent = "Signing...";

      log.warn("[dot.li signing] dispatching signRaw to session");

      const signRawRequest = { productAccountId, data };
      void withTimeout(session.signRaw(signRawRequest), SIGN_TIMEOUT_MS).then(
        (result) => {
          result.match(
            ({ signature, signedTransaction }) => {
              log.warn("[dot.li signing] signRaw SUCCESS:", {
                signature: toHex(signature).slice(0, 20) + "...",
                hasSignedTx: !!signedTransaction,
              });
              removeModal(backdrop);
              resolve({
                signature: toHex(signature),
                signedTransaction: signedTransaction
                  ? typeof signedTransaction === "string"
                    ? signedTransaction
                    : toHex(signedTransaction)
                  : undefined,
              });
            },
            (e) => {
              log.error("[dot.li signing] signRaw FAILED:", e.message, e);
              removeModal(backdrop);
              reject(new SigningErr.Unknown({ reason: e.message }));
            },
          );
        },
        (e: unknown) => {
          log.error("[dot.li signing] signRaw timed out:", e);
          removeModal(backdrop);
          const msg = e instanceof Error ? e.message : "Request timed out";
          reject(new SigningErr.Unknown({ reason: msg }));
        },
      );
    });
  });
}

/**
 * Create-transaction modal. host-api 0.7.9 delegates extrinsic construction
 * to the wallet via host_create_transaction. The host forwards the typed
 * payload (signer tuple, genesis hash, call data, extensions, txExtVersion)
 * and the wallet returns the signed extrinsic bytes. The legacy-account
 * variant routes through the same flow with a synthetic product-account
 * tuple, see handleCreateTransactionWithLegacyAccount in container.ts.
 */
export function showCreateTransactionModal(
  session: UserSession,
  payload: ContainerCreateTransactionPayload,
  appLabel: string,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const signerLabel = `${payload.signer[0]} / ${String(payload.signer[1])}`;
    const genesisHashHex = toHex(payload.genesisHash);
    const callDataHex = toHex(payload.callData);
    const callDataPreview =
      callDataHex.length > 80 ? `${callDataHex.slice(0, 80)}...` : callDataHex;

    log.warn("[dot.li signing] createTransaction request received:", {
      appLabel,
      signer: payload.signer,
      genesisHash: genesisHashHex,
      callDataLen: payload.callData.length,
      extensions: payload.extensions.map((e) => e.id),
      txExtVersion: payload.txExtVersion,
    });
    log.warn("[dot.li signing] session info:", {
      localAccountId: toHex(session.localAccount.accountId),
      sessionRoot: toHex(session.remoteAccount.accountId),
    });

    const fields: { label: string; value: string; mono?: boolean }[] = [
      { label: "App", value: appLabel },
      { label: "Signer", value: signerLabel },
      { label: "Genesis Hash", value: genesisHashHex, mono: true },
      { label: "Call Data", value: callDataPreview, mono: true },
      { label: "Tx Ext Version", value: String(payload.txExtVersion) },
    ];

    const { backdrop, signBtn, cancelBtn } = createModalDOM(
      "Sign Transaction",
      fields,
    );

    cancelBtn.addEventListener("click", () => {
      log.warn("[dot.li signing] user cancelled createTransaction");
      removeModal(backdrop);
      reject(new CreateTransactionErr.Rejected());
    });

    signBtn.addEventListener("click", () => {
      signBtn.disabled = true;
      signBtn.textContent = "Signing...";

      log.warn("[dot.li signing] dispatching createTransaction to session");

      void withTimeout(
        session.createTransaction({
          payload: enumValue("v1", payload),
        }),
        SIGN_TIMEOUT_MS,
      ).then(
        (result) => {
          result.match(
            (signedTransaction) => {
              log.warn("[dot.li signing] createTransaction SUCCESS:", {
                signedTxLen: signedTransaction.length,
              });
              removeModal(backdrop);
              resolve(signedTransaction);
            },
            (e) => {
              log.error(
                "[dot.li signing] createTransaction FAILED:",
                e.message,
                e,
              );
              removeModal(backdrop);
              reject(new CreateTransactionErr.Unknown({ reason: e.message }));
            },
          );
        },
        (e: unknown) => {
          log.error("[dot.li signing] createTransaction timed out:", e);
          removeModal(backdrop);
          const msg = e instanceof Error ? e.message : "Request timed out";
          reject(new CreateTransactionErr.Unknown({ reason: msg }));
        },
      );
    });
  });
}

/**
 * Sign-raw modal for a true legacy (imported) account.
 *
 * Unlike `showSignRawModal`, the wallet is asked to sign with a concrete
 * account public key (`signRawLegacy`) rather than deriving a product key from
 * a `[dotNsIdentifier, index]` tuple. host-papp's `signRawLegacy` returns the
 * raw signature only (no signed transaction).
 */
export function showSignRawLegacyModal(
  session: UserSession,
  data: ContainerSignRawRequest["payload"],
  appLabel: string,
  account: Uint8Array,
): Promise<SigningResult> {
  return new Promise((resolve, reject) => {
    const signerLabel = productPublicKeyToAddress(account);
    const message = data.tag === "Payload" ? data.value : toHex(data.value);

    const fields: { label: string; value: string; mono?: boolean }[] = [
      { label: "App", value: appLabel },
      { label: "Signer", value: signerLabel, mono: true },
      { label: "Message", value: message, mono: true },
    ];

    const { backdrop, signBtn, cancelBtn } = createModalDOM(
      "Sign Message",
      fields,
    );

    cancelBtn.addEventListener("click", () => {
      removeModal(backdrop);
      reject(new SigningErr.Rejected());
    });

    signBtn.addEventListener("click", () => {
      signBtn.disabled = true;
      signBtn.textContent = "Signing...";

      void withTimeout(
        session.signRawLegacy({ account, data }),
        SIGN_TIMEOUT_MS,
      ).then(
        (result) => {
          result.match(
            (signature) => {
              removeModal(backdrop);
              resolve({ signature: toHex(signature) });
            },
            (e) => {
              log.error("[dot.li signing] signRawLegacy FAILED:", e.message, e);
              removeModal(backdrop);
              reject(new SigningErr.Unknown({ reason: e.message }));
            },
          );
        },
        (e: unknown) => {
          log.error("[dot.li signing] signRawLegacy timed out:", e);
          removeModal(backdrop);
          const msg = e instanceof Error ? e.message : "Request timed out";
          reject(new SigningErr.Unknown({ reason: msg }));
        },
      );
    });
  });
}

/**
 * Create-transaction modal for a true legacy (imported) account. Mirrors
 * `showCreateTransactionModal` but routes through host-papp's
 * `createTransactionLegacy`, which carries the signer as a raw public key.
 */
export function showCreateTransactionLegacyModal(
  session: UserSession,
  payload: ContainerCreateTransactionLegacyPayload,
  appLabel: string,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const signerLabel = productPublicKeyToAddress(payload.signer);
    const genesisHashHex = toHex(payload.genesisHash);
    const callDataHex = toHex(payload.callData);
    const callDataPreview =
      callDataHex.length > 80 ? `${callDataHex.slice(0, 80)}...` : callDataHex;

    const fields: { label: string; value: string; mono?: boolean }[] = [
      { label: "App", value: appLabel },
      { label: "Signer", value: signerLabel, mono: true },
      { label: "Genesis Hash", value: genesisHashHex, mono: true },
      { label: "Call Data", value: callDataPreview, mono: true },
      { label: "Tx Ext Version", value: String(payload.txExtVersion) },
    ];

    const { backdrop, signBtn, cancelBtn } = createModalDOM(
      "Sign Transaction",
      fields,
    );

    cancelBtn.addEventListener("click", () => {
      removeModal(backdrop);
      reject(new CreateTransactionErr.Rejected());
    });

    signBtn.addEventListener("click", () => {
      signBtn.disabled = true;
      signBtn.textContent = "Signing...";

      void withTimeout(
        session.createTransactionLegacy({
          payload: enumValue("v1", payload),
        }),
        SIGN_TIMEOUT_MS,
      ).then(
        (result) => {
          result.match(
            (signedTransaction) => {
              removeModal(backdrop);
              resolve(signedTransaction);
            },
            (e) => {
              log.error(
                "[dot.li signing] createTransactionLegacy FAILED:",
                e.message,
                e,
              );
              removeModal(backdrop);
              reject(new CreateTransactionErr.Unknown({ reason: e.message }));
            },
          );
        },
        (e: unknown) => {
          log.error("[dot.li signing] createTransactionLegacy timed out:", e);
          removeModal(backdrop);
          const msg = e instanceof Error ? e.message : "Request timed out";
          reject(new CreateTransactionErr.Unknown({ reason: msg }));
        },
      );
    });
  });
}

/**
 * Sign-payload modal for a true legacy (imported) account. host-papp has no
 * `signPayloadLegacy`, so the JSON-encoded payload is signed through
 * `signRawLegacy` (Payload variant), mirroring polkadot-desktop. Returns the
 * raw signature only (no signed transaction).
 */
export function showSignPayloadLegacyModal(
  session: UserSession,
  payload: ContainerSignPayloadRequest["payload"],
  appLabel: string,
  account: Uint8Array,
): Promise<SigningResult> {
  return new Promise((resolve, reject) => {
    const signerLabel = productPublicKeyToAddress(account);

    const fields: { label: string; value: string; mono?: boolean }[] = [
      { label: "App", value: appLabel },
      { label: "Signer", value: signerLabel, mono: true },
      { label: "Genesis Hash", value: payload.genesisHash, mono: true },
      { label: "Call Data", value: payload.method, mono: true },
    ];

    const { backdrop, signBtn, cancelBtn } = createModalDOM(
      "Sign Transaction",
      fields,
    );

    cancelBtn.addEventListener("click", () => {
      removeModal(backdrop);
      reject(new SigningErr.Rejected());
    });

    signBtn.addEventListener("click", () => {
      signBtn.disabled = true;
      signBtn.textContent = "Signing...";

      void withTimeout(
        session.signRawLegacy({
          account,
          data: { tag: "Payload", value: JSON.stringify(payload) },
        }),
        SIGN_TIMEOUT_MS,
      ).then(
        (result) => {
          result.match(
            (signature) => {
              removeModal(backdrop);
              resolve({ signature: toHex(signature) });
            },
            (e) => {
              log.error(
                "[dot.li signing] signPayloadLegacy FAILED:",
                e.message,
                e,
              );
              removeModal(backdrop);
              reject(new SigningErr.Unknown({ reason: e.message }));
            },
          );
        },
        (e: unknown) => {
          log.error("[dot.li signing] signPayloadLegacy timed out:", e);
          removeModal(backdrop);
          const msg = e instanceof Error ? e.message : "Request timed out";
          reject(new SigningErr.Unknown({ reason: msg }));
        },
      );
    });
  });
}
