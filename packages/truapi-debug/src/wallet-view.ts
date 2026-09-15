// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  SetupOptions,
  InspectorIdentity as Identity,
  InspectorProduct as Product,
  InspectorResource as Resource,
} from "./panel.ts";
import type { EventStore, StoredTruapiEvent } from "./event-store.ts";

type Wallet = NonNullable<SetupOptions["experimentalWallet"]>;

function button(label: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "td-btn";
  element.textContent = label;
  return element;
}

function paragraph(text: string): HTMLParagraphElement {
  const element = document.createElement("p");
  element.textContent = text;
  return element;
}

function field(parent: HTMLElement, label: string, value: string): void {
  const row = paragraph("");
  const title = document.createElement("strong");
  title.textContent = `${label}: `;
  row.append(title, document.createTextNode(value));
  parent.append(row);
}

export interface WalletView {
  entry: HTMLButtonElement;
  content: HTMLElement;
  overview: HTMLElement;
  recovery: HTMLElement;
  productDetails: HTMLElement;
  isOpen(): boolean;
  setVisible(visible: boolean): void;
  isRecoveryVisible(): boolean;
  onVisibilityChange(callback: () => void): void;
  setIdentity(identity: Identity | undefined): void;
  dispose(): void;
}

/** Wallet content inside the shared debug pane; activity stays in its existing views. */
export function createWalletView(
  wallet: Wallet,
  store: EventStore,
): WalletView {
  const entry = button(
    wallet.isActive() ? "Wallet · username unknown" : "Connect wallet",
  );
  entry.classList.add("td-wallet-entry");
  entry.setAttribute("aria-controls", "td-wallet-view");
  entry.setAttribute("aria-expanded", "false");
  entry.setAttribute("aria-live", "polite");
  entry.setAttribute("aria-atomic", "true");
  const content = document.createElement("section");
  content.id = "td-wallet-view";
  content.className = "td-wallet-view hidden";
  content.setAttribute("role", "tabpanel");
  content.setAttribute("aria-labelledby", "td-tab-wallet");
  content.tabIndex = 0;
  const overview = document.createElement("div");
  overview.className = "td-wallet-overview";
  const recoveryDetails = document.createElement("details");
  recoveryDetails.className = "td-wallet-recovery";
  const recoverySummary = document.createElement("summary");
  recoverySummary.textContent = "Recovery";
  const recovery = document.createElement("div");
  recovery.className = "td-wallet-recovery-content";
  recoveryDetails.append(recoverySummary, recovery);
  const productDetails = document.createElement("section");
  productDetails.className = "td-wallet-product";
  content.append(overview, recoveryDetails);

  let opened = false;
  let disposed = false;
  let identity: Identity | undefined;
  let product: Product | null = null;
  let productGeneration = 0;
  let selectionGeneration = 0;
  let minimumSeq = (store.list().at(-1)?.seq ?? -1) + 1;
  let actionPending = false;
  let renderFrame = 0;
  const outcomes = new Map<string, { status: string; at: number }>();
  const resourceButtons: HTMLButtonElement[] = [];
  let onVisibilityChange = (): void => {
    /* The wallet controls attach their sensitive-state cleanup after mounting. */
  };
  const isDisposed = (): boolean => disposed;

  function setVisible(next: boolean): void {
    if (disposed || opened === next) {
      return;
    }
    opened = next;
    entry.setAttribute("aria-expanded", String(opened));
    if (!opened) {
      recoveryDetails.open = false;
    }
    onVisibilityChange();
    if (opened) {
      void loadProduct();
    }
  }

  function currentEvents(): StoredTruapiEvent[] {
    if (identity === undefined || product === null) {
      return [];
    }
    return store
      .list()
      .filter(
        (event): event is StoredTruapiEvent =>
          event.kind === "truapi" &&
          event.seq >= minimumSeq &&
          event.productId === product?.id,
      );
  }

  function allocationResources(
    event: StoredTruapiEvent,
  ): (Resource | null)[] | null {
    if (
      event.tag !== "resource_allocation_request_request" ||
      typeof event.payload !== "object" ||
      event.payload === null ||
      !("resources" in event.payload) ||
      !Array.isArray(event.payload.resources)
    ) {
      return null;
    }
    const resources: (Resource | null)[] = [];
    for (const value of event.payload.resources) {
      const resource = wallet.describeResource(value);
      // Preserve batch indices, including permission resources that are not allowances.
      resources.push(resource);
    }
    return resources;
  }

  function allocationOutcomes(event: StoredTruapiEvent): string[] | null {
    if (
      event.tag !== "resource_allocation_request_response" ||
      typeof event.payload !== "object" ||
      event.payload === null ||
      !("outcomes" in event.payload) ||
      !Array.isArray(event.payload.outcomes)
    ) {
      return null;
    }
    const results: string[] = [];
    const values: unknown[] = event.payload.outcomes;
    for (const value of values) {
      if (
        value !== "Allocated" &&
        value !== "Rejected" &&
        value !== "NotAvailable"
      ) {
        return null;
      }
      results.push(value);
    }
    return results;
  }

  function observedResources(): {
    resources: Resource[];
    results: Map<string, { status: string; at: number }>;
  } {
    const resources = new Map(
      product?.resources.map((resource) => [resource.id, resource]),
    );
    const results = new Map(outcomes);
    const requests = new Map<string, (Resource | null)[]>();
    for (const event of currentEvents()) {
      const batch = allocationResources(event);
      if (batch !== null) {
        requests.set(event.requestId, batch);
        for (const resource of batch) {
          if (resource !== null) {
            resources.set(resource.id, resource);
          }
        }
      }
      const statuses = allocationOutcomes(event);
      const requested = requests.get(event.requestId);
      if (requested === undefined || requested.length !== statuses?.length) {
        continue;
      }
      requested.forEach((resource, index) => {
        if (resource === null) {
          return;
        }
        const status = statuses[index];
        if ((results.get(resource.id)?.at ?? 0) <= event.receivedAt) {
          results.set(resource.id, { status, at: event.receivedAt });
        }
      });
    }
    return { resources: Array.from(resources.values()), results };
  }

  function renderProduct(): void {
    const focusedResource =
      document.activeElement instanceof HTMLButtonElement &&
      productDetails.contains(document.activeElement)
        ? document.activeElement.dataset.resource
        : undefined;
    resourceButtons.length = 0;
    productDetails.replaceChildren();
    const title = document.createElement("h3");
    title.textContent = "Current product";
    productDetails.append(title);
    if (identity === undefined) {
      productDetails.append(
        paragraph(
          "Connect the experimental wallet to inspect its product account and permissions.",
        ),
      );
      return;
    }
    if (product === null) {
      productDetails.append(
        paragraph(
          "No active product. Open a product to inspect its native account and permissions.",
        ),
      );
      return;
    }
    field(productDetails, "Product", product.name);
    field(productDetails, "Product ID", product.id);
    field(productDetails, "Origin", product.origin);
    field(
      productDetails,
      "Product account public key",
      product.accountPublicKey ?? "Unavailable",
    );
    if (product.accountError !== undefined) {
      productDetails.append(paragraph(product.accountError));
    }
    field(productDetails, "Derivation", product.derivation);
    const permissionsTitle = document.createElement("h3");
    permissionsTitle.textContent = "Product permissions";
    productDetails.append(permissionsTitle);
    for (const permission of product.permissions) {
      field(productDetails, permission.label, permission.status);
    }
    if (product.permissions.length === 0) {
      productDetails.append(
        paragraph("No persisted permissions are exposed for this product."),
      );
    }
    productDetails.append(
      paragraph(
        "Permission changes are reviewed by the host when a product requests access. The Wallet tab does not grant permissions implicitly.",
      ),
    );
    const allowancesTitle = document.createElement("h3");
    allowancesTitle.textContent = "Allowances";
    productDetails.append(
      allowancesTitle,
      paragraph(
        "The native host does not expose remaining quota or balance counters. Results below are last observed allocation outcomes, not current balances. Amount is host-determined; fees are not exposed. Nothing is replenished automatically.",
      ),
    );
    const observed = observedResources();
    for (const resource of observed.resources) {
      const row = document.createElement("div");
      row.className = "td-wallet-resource";
      field(row, "Resource", resource.label);
      const outcome = observed.results.get(resource.id);
      row.append(
        paragraph(
          outcome === undefined
            ? "No allocation outcome observed in this capture."
            : `Last observed: ${outcome.status} · ${new Date(outcome.at).toLocaleString()}. Remaining quota unknown.`,
        ),
      );
      const request = button(
        outcome?.status === "Allocated"
          ? "Request renewal…"
          : "Request allocation…",
      );
      request.dataset.resource = resource.id;
      request.disabled =
        actionPending || outcome?.status.startsWith("Outcome unknown") === true;
      request.addEventListener("click", () => {
        void requestResource(resource);
      });
      resourceButtons.push(request);
      row.append(request);
      productDetails.append(row);
      if (focusedResource === resource.id && !request.disabled) {
        request.focus({ preventScroll: true });
      }
    }
  }

  function recordOutcome(id: string, status: string): void {
    outcomes.delete(id);
    outcomes.set(id, { status, at: Date.now() });
    if (outcomes.size > store.capacity) {
      const oldest = outcomes.keys().next().value;
      if (oldest !== undefined) {
        outcomes.delete(oldest);
      }
    }
  }

  function isCurrentSelection(
    selectedIdentity: Identity,
    selectedProduct: Product,
  ): boolean {
    return (
      !disposed &&
      identity?.identityAccountId === selectedIdentity.identityAccountId &&
      identity.network === selectedIdentity.network &&
      product?.id === selectedProduct.id
    );
  }

  async function requestResource(resource: Resource): Promise<void> {
    if (
      actionPending ||
      product === null ||
      identity === undefined ||
      disposed
    ) {
      return;
    }
    const selectedProduct = product;
    const selectedIdentity = identity;
    const selectedGeneration = selectionGeneration;
    if (
      !window.confirm(
        `Request ${resource.label}?\n\nProduct: ${selectedProduct.name} (${selectedProduct.id})\nIdentity: ${selectedIdentity.identityAccountId}\nNetwork: ${selectedIdentity.network}\n\nAmount is determined by the native host; fees and remaining quota are not exposed. The host must review this explicit request. No automatic renewal.`,
      )
    ) {
      return;
    }
    actionPending = true;
    for (const request of resourceButtons) {
      request.disabled = true;
    }
    try {
      const result = await wallet.requestResource(
        selectedProduct.id,
        resource.request,
      );
      if (
        selectedGeneration !== selectionGeneration ||
        !isCurrentSelection(selectedIdentity, selectedProduct)
      ) {
        return;
      }
      recordOutcome(resource.id, result);
    } catch {
      // Native errors may carry arbitrary details. Never retain/display them as activity.
      if (
        selectedGeneration === selectionGeneration &&
        isCurrentSelection(selectedIdentity, selectedProduct)
      ) {
        recordOutcome(
          resource.id,
          "Outcome unknown — inspect host state before another request; no retry was made",
        );
      }
    } finally {
      actionPending = false;
      if (!isDisposed()) {
        renderProduct();
      }
    }
  }

  async function loadProduct(): Promise<void> {
    const generation = ++productGeneration;
    if (identity === undefined) {
      product = null;
      renderProduct();
      return;
    }
    try {
      const result = await wallet.getProduct();
      if (disposed || generation !== productGeneration) {
        return;
      }
      if (product?.id !== result?.id) {
        outcomes.clear();
      }
      product = result;
      renderProduct();
    } catch {
      if (disposed || generation !== productGeneration) {
        return;
      }
      product = null;
      productDetails.replaceChildren(
        paragraph(
          "Current product information is unavailable from the native host. No account or allowance is inferred.",
        ),
      );
    }
  }

  const productChanged = (): void => {
    productGeneration++;
    selectionGeneration++;
    product = null;
    minimumSeq = (store.list().at(-1)?.seq ?? -1) + 1;
    outcomes.clear();
    renderProduct();
    void loadProduct();
  };
  const pageHidden = (): void => {
    if (document.hidden) {
      recoveryDetails.open = false;
      onVisibilityChange();
    }
  };
  let allocationsChanged = false;
  const unsubscribe = store.subscribe(() => {
    const events = store.list();
    const latest = events.at(-1);
    if (events.length === 0) {
      outcomes.clear();
      allocationsChanged = true;
    } else if (
      latest?.kind === "truapi" &&
      latest.productId === product?.id &&
      (latest.tag === "resource_allocation_request_request" ||
        latest.tag === "resource_allocation_request_response")
    ) {
      allocationsChanged = true;
    }
    if (renderFrame !== 0 || !opened) {
      return;
    }
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      if (disposed) {
        return;
      }
      if (allocationsChanged) {
        allocationsChanged = false;
        renderProduct();
      }
    });
  });
  recoveryDetails.addEventListener("toggle", () => {
    onVisibilityChange();
  });
  window.addEventListener("dotli:product-loaded", productChanged);
  document.addEventListener("visibilitychange", pageHidden);

  return {
    entry,
    content,
    overview,
    recovery,
    productDetails,
    setVisible,
    isOpen: (): boolean => opened && !disposed,
    isRecoveryVisible: (): boolean =>
      opened && recoveryDetails.open && !document.hidden && !disposed,
    onVisibilityChange(callback: () => void): void {
      onVisibilityChange = callback;
    },
    setIdentity(next: Identity | undefined): void {
      if (
        next?.identityAccountId !== identity?.identityAccountId ||
        next?.network !== identity?.network
      ) {
        minimumSeq = (store.list().at(-1)?.seq ?? -1) + 1;
        outcomes.clear();
        productGeneration++;
        selectionGeneration++;
        product = null;
      }
      identity = next;
      const fullName = next?.fullUsername ?? "";
      const liteName = next?.liteUsername ?? "";
      entry.textContent = wallet.isActive()
        ? fullName || liteName || "Wallet · username unknown"
        : "Connect wallet";
      void loadProduct();
    },
    dispose(): void {
      disposed = true;
      onVisibilityChange();
      productGeneration++;
      unsubscribe();
      cancelAnimationFrame(renderFrame);
      window.removeEventListener("dotli:product-loaded", productChanged);
      document.removeEventListener("visibilitychange", pageHidden);
      content.remove();
      entry.remove();
    },
  };
}
