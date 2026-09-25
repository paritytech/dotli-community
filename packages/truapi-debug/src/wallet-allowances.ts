// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  AllowanceClaims,
  AllowanceObservation,
  AllowanceSection,
  WalletAllowanceSnapshot,
} from "@parity/truapi-host/web";

function paragraph(text: string, className?: string): HTMLParagraphElement {
  const element = document.createElement("p");
  element.textContent = text;
  if (className !== undefined) {
    element.className = className;
  }
  return element;
}

function field(parent: HTMLElement, label: string, value: string): void {
  const row = paragraph("");
  const title = document.createElement("strong");
  title.textContent = `${label}: `;
  row.append(title, document.createTextNode(value));
  parent.append(row);
}

/** Never round on-chain integers through Number or apply guessed token decimals. */
function integer(value: string | number | undefined): string {
  if (value === undefined) {
    return "Unavailable";
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0
      ? value.toLocaleString("en-US")
      : "Unavailable";
  }
  return /^\d+$/.test(value)
    ? BigInt(value).toLocaleString("en-US")
    : "Unavailable";
}

function timestamp(seconds: number): string {
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime())
    ? date.toISOString().replace("T", " ").replace(".000Z", " UTC")
    : "Unavailable";
}

function source(
  parent: HTMLElement,
  observation: AllowanceObservation,
  chain: string,
): void {
  const details = document.createElement("details");
  details.className = "td-wallet-details td-wallet-allowance-source";
  const summary = document.createElement("summary");
  summary.textContent = `${chain} · finalized block ${integer(observation.blockNumber)} · ${timestamp(observation.chainTimestamp)}`;
  details.append(summary);
  field(details, "Block hash", observation.blockHash);
  field(details, "Genesis hash", observation.genesisHash);
  field(details, "Runtime spec version", integer(observation.specVersion));
  parent.append(details);
}

function section<T>(
  parent: HTMLElement,
  title: string,
  data: AllowanceSection<T>,
  chain: string,
  render: (body: HTMLElement, value: T) => void,
): void {
  const body = document.createElement("div");
  body.className = "td-wallet-allowance-section";
  const heading = document.createElement("h5");
  heading.textContent = title;
  body.append(heading);
  if (data.status === "unavailable") {
    body.append(paragraph(`Unavailable: ${data.reason}`, "td-wallet-error"));
  } else {
    render(body, data.value);
    source(body, data.observation, chain);
  }
  parent.append(body);
}

function claims(
  parent: HTMLElement,
  value: AllowanceClaims,
  occupancy: boolean,
): void {
  field(parent, "Current period", integer(value.period));
  field(parent, "Period resets", timestamp(value.resetsAt));
  if (value.pools.length === 0) {
    parent.append(
      paragraph("No tier pools were reported. Capacity is not inferred."),
    );
  }
  for (const pool of value.pools) {
    const container = document.createElement("div");
    container.className = "td-wallet-allowance-pool";
    const title = document.createElement("h6");
    title.textContent =
      pool.collection === "People" ? "Full · People" : "Lite · LitePeople";
    container.append(title);
    field(
      container,
      "Membership",
      pool.membership === "verified" ? "Verified" : "Not found",
    );
    field(
      container,
      "Allocation policy",
      pool.selected ? "Selected pool" : "Not selected",
    );
    field(
      container,
      occupancy ? "Publishing slots" : "Period claims",
      `${integer(pool.used)} ${occupancy ? "occupied" : "used"} / ${integer(pool.limit)} limit · ${integer(pool.remaining)} remaining`,
    );
    if (pool.membership === "not-found") {
      container.append(
        paragraph(
          "Membership was not found; this tier is not an available allowance for this identity.",
          "td-wallet-hint",
        ),
      );
    }
    if (pool.slots.length === 0) {
      container.append(
        paragraph(
          occupancy
            ? "No occupied slots reported."
            : "No occupied claim slots reported.",
        ),
      );
    } else {
      const details = document.createElement("details");
      details.className = "td-wallet-details";
      const summary = document.createElement("summary");
      summary.textContent = occupancy
        ? "Occupied slots and recipients"
        : "Occupied claim slots";
      details.append(summary);
      const list = document.createElement("ul");
      list.className = "td-wallet-allowance-slots";
      for (const slot of pool.slots) {
        const item = document.createElement("li");
        field(item, "Slot", integer(slot.index));
        field(
          item,
          "Recipient account",
          slot.accountId ?? "Unknown — recipient not exposed",
        );
        field(
          item,
          "Product attribution",
          slot.productId ?? "Unknown — no verified product mapping",
        );
        if (slot.label !== undefined) {
          field(item, "Host description", slot.label);
        }
        if (slot.since !== undefined) {
          field(item, "Since", timestamp(slot.since));
        }
        list.append(item);
      }
      details.append(list);
      container.append(details);
    }
    parent.append(container);
  }
}

function tokenBalance(
  balance: string,
  decimals: number | null,
  symbol: string | null,
): string {
  const base = integer(balance);
  if (base === "Unavailable") {
    return "Unavailable — invalid balance";
  }
  if (
    decimals === null ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  ) {
    return `${base} base units (token decimals unavailable)`;
  }
  const digits = BigInt(balance)
    .toString()
    .padStart(decimals + 1, "0");
  const units =
    decimals === 0
      ? integer(digits)
      : `${integer(digits.slice(0, -decimals))}.${digits.slice(-decimals)}`;
  return `${units} ${symbol ?? "tokens"} (${base} base units; ${String(decimals)} decimals)`;
}

/** Read-only current state; never derive consumption or action costs from these values. */
export function renderAllowanceSnapshot(
  parent: HTMLElement,
  snapshot: WalletAllowanceSnapshot,
): void {
  parent.replaceChildren();
  field(parent, "Identity", snapshot.identityAccountId);
  field(parent, "Network", snapshot.networkSuffix);
  parent.append(
    paragraph(
      snapshot.productIds.length === 0
        ? "No active product. Wallet-wide publishing slots and claim capacities are shown; product balances and quotas need an active product. Other wallets and non-default product accounts are outside this view."
        : "Wallet-wide publishing slots and claim capacities are shown. PGAS balances cover only the current product’s default account, Index(0). Bulletin quotas cover its separate storage account. Other products and derivations are outside this view.",
      "td-wallet-hint",
    ),
  );
  for (const productId of snapshot.productIds) {
    field(parent, "Inspected product", productId);
  }
  const group = (title: string): HTMLElement => {
    const container = document.createElement("section");
    container.className = "td-wallet-allowance-group";
    const heading = document.createElement("h4");
    heading.textContent = title;
    container.append(heading);
    parent.append(container);
    return container;
  };

  const statement = group("Statement publishing");
  statement.append(
    paragraph(
      "Occupied publishing slots and recipients, not statement counts or consumed bytes. Eligible tier pools are shown separately; unknown recipients are not attributed to this product.",
      "td-wallet-hint",
    ),
  );
  section(
    statement,
    "Wallet-wide slot occupancy",
    snapshot.statementStore,
    "People",
    (body, value) => {
      claims(body, value, true);
      field(body, "Grace period", `${integer(value.graceSeconds)} seconds`);
      field(
        body,
        "Replacement cooldown",
        `${integer(value.replacementCooldownSeconds)} seconds`,
      );
    },
  );

  const pgas = group("PGAS");
  section(
    pgas,
    "Current product balance · Index(0)",
    snapshot.pgasBalances,
    "Asset Hub",
    (body, value) => {
      field(body, "Asset ID", value.assetId);
      field(body, "Token symbol", value.symbol ?? "Unavailable");
      field(
        body,
        "Token decimals",
        value.decimals === null
          ? "Unavailable — base units only"
          : integer(value.decimals),
      );
      if (value.accounts.length === 0) {
        body.append(
          paragraph(
            snapshot.productIds.length === 0
              ? "No active product account to inspect."
              : "No product account balance was returned. Balance is unknown.",
          ),
        );
      }
      for (const account of value.accounts) {
        const row = document.createElement("div");
        row.className = "td-wallet-allowance-pool";
        field(row, "Product", account.productId);
        field(row, "Account", account.accountId);
        field(row, "Derivation", `Index(${String(account.derivationIndex)})`);
        field(
          row,
          "Total balance",
          account.balance === null
            ? "Unavailable"
            : tokenBalance(account.balance, value.decimals, value.symbol),
        );
        if (account.error !== undefined) {
          row.append(paragraph(account.error, "td-wallet-error"));
        }
        body.append(row);
      }
      body.append(
        paragraph(
          "Total balance is not a promise of spendability and does not identify fees, spending or funding history.",
          "td-wallet-hint",
        ),
      );
    },
  );
  section(
    pgas,
    "Wallet-wide claim capacity",
    snapshot.pgasClaims,
    "Asset Hub",
    (body, value) => {
      field(body, "Claim asset ID", value.assetId);
      field(
        body,
        "Amount per claim",
        `${integer(value.claimAmount)} base units`,
      );
      body.append(
        paragraph(
          "Claim capacities are separate from the product balance. Only the policy-selected pool is used for allocation; tier capacities are not added together.",
          "td-wallet-hint",
        ),
      );
      claims(body, value, false);
      source(body, value.membershipObservation, "People membership");
    },
  );

  const bulletin = group("Bulletin storage");
  section(
    bulletin,
    "Wallet-wide claim capacity",
    snapshot.bulletinClaims,
    "People",
    (body, value) => {
      body.append(
        paragraph(
          "Claims authorize storage; they are not stored bytes. Only the policy-selected pool is used for allocation; tier capacities are not added together.",
          "td-wallet-hint",
        ),
      );
      claims(body, value, false);
    },
  );
  section(
    bulletin,
    "Current product storage account authorization",
    snapshot.bulletinQuotas,
    "Bulletin",
    (body, value) => {
      if (value.accounts.length === 0) {
        body.append(
          paragraph(
            snapshot.productIds.length === 0
              ? "No active product account to inspect."
              : "No product authorization was returned. Quota is unknown.",
          ),
        );
      }
      for (const account of value.accounts) {
        const row = document.createElement("div");
        row.className = "td-wallet-allowance-pool";
        field(row, "Product", account.productId);
        field(row, "Account", account.accountId);
        field(
          row,
          "Authorization",
          account.status === "active"
            ? "Active at the source block"
            : account.status === "expired"
              ? "Expired — remaining quota is not usable"
              : account.status === "missing"
                ? "Not found — no storage authorization"
                : "Unavailable",
        );
        if (account.status === "active" || account.status === "expired") {
          field(
            row,
            "Bytes",
            `${integer(account.bytesUsed)} used / ${integer(account.bytesLimit)} limit · ${integer(account.bytesRemaining)} remaining bytes`,
          );
          field(
            row,
            "Submissions",
            `${integer(account.transactionsUsed)} used / ${integer(account.transactionsLimit)} limit · ${integer(account.transactionsRemaining)} remaining submissions`,
          );
          field(
            row,
            "Expiry",
            account.expiresAtBlock === undefined
              ? "Unavailable"
              : `Bulletin block ${integer(account.expiresAtBlock)}`,
          );
        }
        if (account.error !== undefined) {
          row.append(paragraph(account.error, "td-wallet-error"));
        }
        body.append(row);
      }
    },
  );
}
