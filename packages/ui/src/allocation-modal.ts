// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Allowance request modal.
 *
 * Lists the resources a product wants pre-allocated and runs the wallet
 * round-trip on Allow. On error the modal stays open so the user can retry.
 */

import type {
  AllocatableResource,
  AllocationOutcome,
  CodecType,
} from "@novasamatech/host-api";

export type AllocatableResourceValue = CodecType<typeof AllocatableResource>;
export type AllocationOutcomeValue = CodecType<typeof AllocationOutcome>;

/** Optional dependencies for {@link showAllocationRequestModal}. */
export interface AllocationModalOptions {
  /**
   * Resolve the SS58 address of the app account that auto-signs for a
   * `SmartContractAllowance` at the given derivation index. When provided, the
   * smart-contract line gets an info tooltip naming that account; when omitted
   * (e.g. in unit tests) the tooltip is simply not rendered.
   */
  resolveContractAccount?: (index: number) => string;
}

// Feather-style glyphs, inlined to match the rest of the UI (see topbar.ts).
const INFO_ICON_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';
const COPY_ICON_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const CHEVRON_ICON_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

let tooltipSeq = 0;

/**
 * A `setTimeout` wrapper whose `schedule()` (re)starts the timer, replacing any
 * pending run, and `cancel()` clears it — keeps the clear-then-set bookkeeping
 * in one place.
 */
function resettableTimeout(
  action: () => void,
  delayMs: number,
): { schedule: () => void; cancel: () => void } {
  let id: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    if (id !== undefined) {
      clearTimeout(id);
      id = undefined;
    }
  };
  return {
    cancel,
    schedule: () => {
      cancel();
      id = setTimeout(action, delayMs);
    },
  };
}

/**
 * Build the info icon + hover/focus tooltip naming the app account that will
 * auto-sign smart-contract calls. The tooltip is `position: fixed` (placed via
 * JS on reveal) so it escapes the `.signing-fields` overflow clip.
 */
function buildContractAccountInfo(index: number, address: string): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "allocation-info-wrap";

  const tooltipId = `allocation-account-tip-${String(++tooltipSeq)}`;

  const icon = document.createElement("span");
  icon.className = "allocation-info-icon";
  icon.tabIndex = 0;
  icon.setAttribute("role", "button");
  icon.setAttribute("aria-label", "Show signing account");
  icon.setAttribute("aria-describedby", tooltipId);
  icon.innerHTML = INFO_ICON_SVG;
  wrap.appendChild(icon);

  const tooltip = document.createElement("span");
  tooltip.className = "allocation-tooltip";
  tooltip.id = tooltipId;
  tooltip.setAttribute("role", "tooltip");

  const title = document.createElement("span");
  title.className = "allocation-tooltip-title";
  title.textContent =
    "Following accounts will sign contract calls automatically:";
  tooltip.appendChild(title);

  // Keep the SS58 address tucked behind a native disclosure so the tooltip
  // stays compact; the summary names the account, expanding reveals the
  // address + copy button.
  const details = document.createElement("details");
  details.className = "allocation-account";

  const summary = document.createElement("summary");
  summary.className = "allocation-account-summary";

  const accountLabel = document.createElement("span");
  accountLabel.className = "allocation-account-label";
  accountLabel.textContent = `App account with index ${String(index)}`;
  summary.appendChild(accountLabel);

  const chevron = document.createElement("span");
  chevron.className = "allocation-account-chevron";
  chevron.innerHTML = CHEVRON_ICON_SVG;
  summary.appendChild(chevron);

  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "allocation-account-body";

  const addr = document.createElement("span");
  addr.className = "allocation-account-address";
  addr.textContent = address;
  body.appendChild(addr);

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "allocation-account-copy";
  copyBtn.title = "Copy address";
  copyBtn.setAttribute("aria-label", "Copy address");
  copyBtn.innerHTML = COPY_ICON_SVG;
  const resetCopied = resettableTimeout(() => {
    copyBtn.classList.remove("copied");
    copyBtn.innerHTML = COPY_ICON_SVG;
  }, 1000);
  copyBtn.addEventListener("click", (e) => {
    // Don't let the click bubble to the backdrop (which dismisses the modal).
    e.stopPropagation();
    void navigator.clipboard.writeText(address).then(() => {
      copyBtn.classList.add("copied");
      copyBtn.innerHTML = CHECK_ICON_SVG;
      resetCopied.schedule();
    });
  });
  body.appendChild(copyBtn);

  details.appendChild(body);
  tooltip.appendChild(details);

  wrap.appendChild(tooltip);

  // Place the fixed tooltip just under the icon, flipping above / clamping to
  // the viewport when it would overflow. Runs in the reveal handler (before
  // paint) so there's no flash at the origin.
  const place = (): void => {
    const iconRect = icon.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();
    const gap = 8;
    let top = iconRect.bottom + gap;
    if (top + tipRect.height > window.innerHeight - gap) {
      top = Math.max(gap, iconRect.top - gap - tipRect.height);
    }
    let left = iconRect.left;
    if (left + tipRect.width > window.innerWidth - gap) {
      left = window.innerWidth - gap - tipRect.width;
    }
    tooltip.style.top = `${String(Math.round(top))}px`;
    tooltip.style.left = `${String(Math.round(Math.max(gap, left)))}px`;
  };
  // Drive visibility from JS (via the `is-open` class) rather than pure CSS
  // `:hover`, so we can keep the tooltip open for a beat after the pointer
  // leaves. Otherwise crossing the gap between the icon and the fixed tooltip
  // drops `:hover` and hides it before the user can reach it to expand.
  const CLOSE_DELAY_MS = 300;
  const closeTooltip = resettableTimeout(() => {
    wrap.classList.remove("is-open");
  }, CLOSE_DELAY_MS);
  const open = (): void => {
    closeTooltip.cancel();
    wrap.classList.add("is-open");
    place();
  };
  wrap.addEventListener("mouseenter", open);
  wrap.addEventListener("mouseleave", closeTooltip.schedule);
  wrap.addEventListener("focusin", open);
  wrap.addEventListener("focusout", closeTooltip.schedule);
  // Expanding/collapsing changes the tooltip height — re-anchor so it doesn't
  // spill off-screen.
  details.addEventListener("toggle", place);

  return wrap;
}

function describeResource(resource: AllocatableResourceValue): string {
  switch (resource.tag) {
    case "StatementStoreAllowance":
      return "Post statements on your behalf";
    case "BulletinAllowance":
      return "Publish bulletin posts on your behalf";
    case "SmartContractAllowance":
      return "Sign smart-contract calls automatically";
    case "AutoSigning":
      return "Sign transactions automatically";
    default: {
      const exhaustive: never = resource;
      return exhaustive;
    }
  }
}

/** Show an allowance request modal and run `performAllocation` on confirm. */
export function showAllocationRequestModal(
  productLabel: string,
  resources: AllocatableResourceValue[],
  performAllocation: () => Promise<AllocationOutcomeValue[]>,
  options: AllocationModalOptions = {},
): Promise<AllocationOutcomeValue[]> {
  return new Promise((resolve, reject) => {
    const backdrop = document.createElement("div");
    backdrop.className = "signing-modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "signing-modal";

    const heading = document.createElement("h2");
    heading.textContent = "Allowance request";
    modal.appendChild(heading);

    const description = document.createElement("div");
    description.className = "signing-fields";

    const productField = document.createElement("div");
    productField.className = "signing-field";

    const productFieldLabel = document.createElement("div");
    productFieldLabel.className = "signing-field-label";
    productFieldLabel.textContent = "Application";
    productField.appendChild(productFieldLabel);

    const productFieldValue = document.createElement("div");
    productFieldValue.className = "signing-field-value";
    productFieldValue.textContent = productLabel;
    productField.appendChild(productFieldValue);

    description.appendChild(productField);

    const resourcesField = document.createElement("div");
    resourcesField.className = "signing-field";

    const resourcesLabel = document.createElement("div");
    resourcesLabel.className = "signing-field-label";
    resourcesLabel.textContent = "Requested allowances";
    resourcesField.appendChild(resourcesLabel);

    const list = document.createElement("ul");
    list.className = "allocation-modal-list";
    for (const resource of resources) {
      const item = document.createElement("li");
      item.textContent = describeResource(resource);
      if (
        resource.tag === "SmartContractAllowance" &&
        options.resolveContractAccount
      ) {
        const address = options.resolveContractAccount(resource.value);
        item.appendChild(buildContractAccountInfo(resource.value, address));
      }
      list.appendChild(item);
    }
    resourcesField.appendChild(list);

    description.appendChild(resourcesField);

    const errorBox = document.createElement("div");
    errorBox.className = "allocation-modal-error";
    errorBox.style.display = "none";
    description.appendChild(errorBox);

    modal.appendChild(description);

    const footer = document.createElement("div");
    footer.className = "signing-modal-footer";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "signing-btn-cancel";
    cancelBtn.textContent = "Cancel";
    footer.appendChild(cancelBtn);

    const allowBtn = document.createElement("button");
    allowBtn.className = "signing-btn-sign";
    allowBtn.textContent = "Allow";
    footer.appendChild(allowBtn);

    modal.appendChild(footer);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    function cleanup(): void {
      backdrop.remove();
    }

    function setPending(pending: boolean): void {
      cancelBtn.disabled = pending;
      allowBtn.disabled = pending;
      allowBtn.textContent = pending ? "Allocating..." : "Allow";
    }

    function showError(message: string): void {
      errorBox.textContent = message;
      errorBox.style.display = "";
    }

    cancelBtn.addEventListener("click", () => {
      cleanup();
      reject(new Error("User cancelled allowance request"));
    });

    allowBtn.addEventListener("click", () => {
      errorBox.style.display = "none";
      setPending(true);
      performAllocation().then(
        (outcomes) => {
          cleanup();
          resolve(outcomes);
        },
        (error: unknown) => {
          setPending(false);
          showError(error instanceof Error ? error.message : String(error));
        },
      );
    });

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop && !allowBtn.disabled) {
        cleanup();
        reject(new Error("User dismissed allowance request"));
      }
    });
  });
}
