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
type View = "overview" | "activity" | "recovery";
const DOCK_KEY = "dotli:host-inspector-docked";

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

interface HostInspector {
  entry: HTMLButtonElement;
  content: HTMLElement;
  overview: HTMLElement;
  recovery: HTMLElement;
  productDetails: HTMLElement;
  isOpen(): boolean;
  isRecoveryVisible(): boolean;
  onVisibilityChange(callback: () => void): void;
  setIdentity(identity: Identity | undefined): void;
  dispose(): void;
}

/** One inspector, sharing the debug store rather than retaining another payload log. */
export function createHostInspector(
  wallet: Wallet,
  store: EventStore,
): HostInspector {
  const entry = button(wallet.isActive() ? "No username" : "Connect wallet");
  entry.classList.add("td-wallet-entry");
  entry.setAttribute("aria-controls", "dotli-host-inspector");
  entry.setAttribute("aria-expanded", "false");
  const backdrop = document.createElement("div");
  backdrop.className = "hi-backdrop";
  backdrop.hidden = true;
  const content = document.createElement("section");
  content.id = "dotli-host-inspector";
  content.className = "host-inspector";
  content.setAttribute("role", "dialog");
  content.setAttribute("aria-labelledby", "hi-heading");
  content.setAttribute("aria-hidden", "true");
  content.inert = true;
  const header = document.createElement("header");
  const heading = document.createElement("h2");
  heading.id = "hi-heading";
  heading.textContent = "Host inspector";
  heading.tabIndex = -1;
  const dock = button("Dock");
  dock.setAttribute("aria-label", "Dock inspector beside product");
  const close = button("Close");
  header.append(heading, dock, close);
  const tablist = document.createElement("div");
  tablist.className = "hi-tabs";
  tablist.setAttribute("role", "tablist");
  tablist.setAttribute("aria-label", "Host inspector views");
  const overview = document.createElement("div");
  const activity = document.createElement("div");
  const recovery = document.createElement("div");
  const views = { overview, activity, recovery };
  const tabs: Record<View, HTMLButtonElement> = {
    overview: button("Overview"),
    activity: button("Activity"),
    recovery: button("Recovery"),
  };
  for (const view of ["overview", "activity", "recovery"] as const) {
    const tab = tabs[view];
    tab.id = `hi-tab-${view}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", `hi-view-${view}`);
    tablist.append(tab);
    views[view].id = `hi-view-${view}`;
    views[view].className = "hi-view";
    views[view].setAttribute("role", "tabpanel");
    views[view].setAttribute("aria-labelledby", tab.id);
    views[view].tabIndex = 0;
    tab.addEventListener("click", () => {
      selectView(view);
    });
    tab.addEventListener("keydown", (event) => {
      const order: View[] = ["overview", "activity", "recovery"];
      const index = order.indexOf(view);
      const next =
        event.key === "ArrowRight"
          ? order[(index + 1) % 3]
          : event.key === "ArrowLeft"
            ? order[(index + 2) % 3]
            : event.key === "Home"
              ? order[0]
              : event.key === "End"
                ? order[2]
                : undefined;
      if (next !== undefined) {
        event.preventDefault();
        selectView(next);
        tabs[next].focus();
      }
    });
  }
  const productDetails = document.createElement("section");
  productDetails.className = "hi-product";
  const activityControls = document.createElement("div");
  const pause = button("Pause activity");
  const clear = button("Clear activity");
  activityControls.append(pause, clear);
  const activityNote = paragraph(
    "Redacted operations for the current product and identity only. Shared debug capture: Pause and Clear also affect the debug panel. No payloads, messages or keys are displayed here.",
  );
  const activityList = document.createElement("ol");
  activityList.className = "hi-activity";
  activity.append(activityNote, activityControls, activityList);
  content.append(header, tablist, overview, activity, recovery);
  const surface = document.createElement("div");
  surface.className = "hi-surface";
  surface.append(content);
  document.body.append(backdrop, surface);

  let opened = false;
  let disposed = false;
  let view: View = "overview";
  let docked = false;
  try {
    docked = localStorage.getItem(DOCK_KEY) === "1";
    // eslint-disable-next-line no-restricted-syntax -- docking is optional when storage is unavailable.
  } catch {
    /* retain overlay */
  }
  const desktop = window.matchMedia("(min-width: 1100px)");
  let returnFocus: HTMLElement | null = null;
  let identity: Identity | undefined;
  let product: Product | null = null;
  let productGeneration = 0;
  let minimumSeq = (store.list().at(-1)?.seq ?? -1) + 1;
  let actionPending = false;
  let renderFrame = 0;
  const outcomes = new Map<string, { status: string; at: number }>();
  const resourceButtons: HTMLButtonElement[] = [];
  let onVisibilityChange = (): void => {
    /* The wallet controls attach their sensitive-state cleanup after mounting. */
  };
  const isDisposed = (): boolean => disposed;

  function selectView(next: View): void {
    view = next;
    for (const name of ["overview", "activity", "recovery"] as const) {
      const tab = tabs[name];
      const selected = name === view;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      views[name].hidden = !selected;
    }
    onVisibilityChange();
    if (opened && view === "activity") {
      renderActivity();
    }
  }

  function geometry(): void {
    const reserved = opened && docked && desktop.matches;
    content.classList.toggle("is-docked", reserved);
    content.setAttribute("aria-modal", String(!reserved));
    dock.hidden = !desktop.matches;
    dock.textContent = docked ? "Undock" : "Dock";
    dock.setAttribute("aria-pressed", String(docked));
    backdrop.hidden = !opened || reserved;
    document.documentElement.style.setProperty(
      "--host-inspector-width",
      reserved ? `${String(content.offsetWidth)}px` : "0px",
    );
  }

  function setOpen(next: boolean): void {
    if (disposed || opened === next) {
      return;
    }
    opened = next;
    if (opened) {
      returnFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : entry;
    }
    content.classList.toggle("is-open", opened);
    content.inert = !opened;
    content.setAttribute("aria-hidden", String(!opened));
    entry.setAttribute("aria-expanded", String(opened));
    geometry();
    onVisibilityChange();
    if (opened) {
      heading.focus();
      void loadProduct();
      renderActivity();
    } else {
      selectView("overview");
      if (returnFocus?.isConnected === true) {
        returnFocus.focus();
      } else {
        entry.focus();
      }
    }
  }

  function keydown(event: KeyboardEvent): void {
    // Native approval dialogs sit above the inspector and own keyboard input.
    if (!opened || document.querySelector(".signing-modal-backdrop") !== null) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "Tab" && !(docked && desktop.matches)) {
      const focusable = Array.from(
        content.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex='0']",
        ),
      ).filter(
        (element) =>
          !element.closest("[hidden]") && element.getClientRects().length > 0,
      );
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === heading ||
          !content.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !content.contains(document.activeElement))
      ) {
        event.preventDefault();
        first?.focus();
      }
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

  function renderActivity(): void {
    pause.textContent = store.isPaused() ? "Resume activity" : "Pause activity";
    activityList.replaceChildren();
    const groups = new Map<
      string,
      { first: StoredTruapiEvent; last: StoredTruapiEvent }
    >();
    for (const event of currentEvents()) {
      const group = groups.get(event.requestId);
      if (group === undefined) {
        groups.set(event.requestId, { first: event, last: event });
      } else {
        group.last = event;
      }
    }
    // Wire operation tags are schema names; never render payload-derived text.
    for (const { first, last } of Array.from(groups.values()).slice(-100)) {
      const row = document.createElement("li");
      const operation = /^[A-Za-z][A-Za-z0-9_.:]{0,100}$/.test(first.tag)
        ? first.tag
        : "Host operation";
      const batch = allocationResources(first);
      const statuses = allocationOutcomes(last);
      const allocationFailed =
        last.tag === "resource_allocation_request_response" &&
        typeof last.payload === "object" &&
        last.payload !== null &&
        "failed" in last.payload &&
        last.payload.failed === true;
      const status =
        batch !== null && statuses !== null && batch.length === statuses.length
          ? batch
              .map(
                (resource, index) =>
                  `${resource?.label ?? "Non-allowance resource (details hidden)"}: ${statuses[index] ?? "Unknown"}`,
              )
              .join("; ")
          : allocationFailed
            ? "Host returned an allocation error; outcome not inferred"
            : last.tag.endsWith("_response")
              ? "Response observed; success not inferred"
              : "Observed; no correlated response retained";
      row.textContent = `${new Date(first.receivedAt).toLocaleTimeString()} · ${operation} · ${status}`;
      activityList.append(row);
    }
    if (groups.size === 0) {
      const empty = document.createElement("li");
      empty.textContent =
        "No observed activity for this product and identity in the retained capture.";
      activityList.append(empty);
    }
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
      "Account public key",
      product.accountPublicKey ?? "Unavailable",
    );
    if (product.accountError !== undefined) {
      productDetails.append(paragraph(product.accountError));
    }
    field(productDetails, "Derivation", product.derivation);
    const permissionsTitle = document.createElement("h3");
    permissionsTitle.textContent = "Permissions";
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
        "Permission changes are reviewed by the host when a product requests access. This inspector does not grant permissions implicitly.",
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
      row.className = "hi-resource";
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
      if (!isCurrentSelection(selectedIdentity, selectedProduct)) {
        return;
      }
      recordOutcome(resource.id, result);
    } catch {
      // Native errors may carry arbitrary details. Never retain/display them as activity.
      if (isCurrentSelection(selectedIdentity, selectedProduct)) {
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
      renderActivity();
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
      renderActivity();
    }
  }

  const open = (): void => {
    setOpen(true);
  };
  const productChanged = (): void => {
    productGeneration++;
    product = null;
    outcomes.clear();
    renderProduct();
    renderActivity();
    void loadProduct();
  };
  const pageHidden = (): void => {
    if (document.hidden) {
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
      if (view === "activity") {
        renderActivity();
      }
      if (allocationsChanged) {
        allocationsChanged = false;
        renderProduct();
      }
    });
  });
  pause.addEventListener("click", () => {
    store.setPaused(!store.isPaused());
  });
  clear.addEventListener("click", () => {
    store.clear();
  });
  entry.addEventListener("click", open);
  close.addEventListener("click", () => {
    setOpen(false);
  });
  backdrop.addEventListener("click", () => {
    setOpen(false);
  });
  dock.addEventListener("click", () => {
    docked = !docked;
    try {
      localStorage.setItem(DOCK_KEY, docked ? "1" : "0");
      // eslint-disable-next-line no-restricted-syntax -- optional preference only.
    } catch {
      /* keep session preference */
    }
    geometry();
  });
  window.addEventListener("dotli:host-inspector-open", open);
  window.addEventListener("dotli:product-loaded", productChanged);
  window.addEventListener("resize", geometry);
  document.addEventListener("keydown", keydown);
  document.addEventListener("visibilitychange", pageHidden);
  selectView("overview");
  geometry();

  return {
    entry,
    content,
    overview,
    recovery,
    productDetails,
    isOpen: (): boolean => opened && !disposed,
    isRecoveryVisible: (): boolean =>
      opened && view === "recovery" && !document.hidden && !disposed,
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
        product = null;
      }
      identity = next;
      entry.textContent = wallet.isActive()
        ? (next?.fullUsername ?? next?.liteUsername ?? "No username")
        : "Connect wallet";
      void loadProduct();
    },
    dispose(): void {
      disposed = true;
      onVisibilityChange();
      productGeneration++;
      unsubscribe();
      cancelAnimationFrame(renderFrame);
      window.removeEventListener("dotli:host-inspector-open", open);
      window.removeEventListener("dotli:product-loaded", productChanged);
      window.removeEventListener("resize", geometry);
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("visibilitychange", pageHidden);
      document.documentElement.style.setProperty(
        "--host-inspector-width",
        "0px",
      );
      surface.remove();
      backdrop.remove();
      entry.remove();
    },
  };
}
