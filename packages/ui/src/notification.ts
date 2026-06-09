// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Notification display
//
// Stackable in-DOM toasts. Auto-dismiss pauses while the tab is
// hidden or the stack is expanded. Optionally fires browser
// Notification API when the tab is hidden.

/** Default auto-dismiss delay in ms. */
export const NOTIFICATION_DISMISS_MS = 10_000;

const MAX_STACK = 3;

const BELL_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>' +
  '<path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

const CLOSE_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<line x1="18" y1="6" x2="6" y2="18"/>' +
  '<line x1="6" y1="6" x2="18" y2="18"/></svg>';

export interface NotificationParams {
  text: string;
  label: string;
  deeplink?: string;
  /** SVG string for the icon. Default: bell. */
  icon?: string;
  /** CSS color for icon background. Default: inherits from .notif-icon (#0a0a0a). */
  iconBackground?: string;
  /** Auto-dismiss in ms. 0 = persistent (manual close only). Default: NOTIFICATION_DISMISS_MS. */
  dismissMs?: number;
  /** Send browser Notification API when tab is hidden. Default: true. */
  browserNotification?: boolean;
  /** Called when the notification is dismissed (user close or auto-dismiss). */
  onDismiss?: () => void;
  /** Optional action button rendered next to the text area. */
  action?: { label: string; onClick: () => void };
}

interface Notif {
  id: number;
  text: string;
  deeplink: string | undefined;
  label: string;
  icon: string;
  iconBackground: string;
  remaining: number;
  startedAt: number;
  el: HTMLElement;
  leaving: boolean;
  onDismiss: (() => void) | undefined;
  action: { label: string; onClick: () => void } | undefined;
}

const items: Notif[] = [];
let expanded = false;
let nextId = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

let root: HTMLElement | null = null;
let cardsEl: HTMLElement | null = null;
let visListenerBound = false;

function sanitizeText(raw: string): string {
  return raw.trim().slice(0, 200);
}

function validateDeeplink(dl: string | undefined): string | undefined {
  if (dl === undefined || dl === "") {
    return undefined;
  }
  try {
    const u = new URL(dl);
    return u.protocol === "https:" || u.protocol === "http:" ? dl : undefined;
  } catch {
    return undefined;
  }
}

function shouldPause(): boolean {
  return expanded || document.visibilityState !== "visible";
}

function startTimer(n: Notif): void {
  if (n.remaining <= 0 || n.leaving || shouldPause()) {
    return;
  }
  n.startedAt = Date.now();
  timers.set(
    n.id,
    setTimeout(() => {
      dismiss(n.id);
    }, n.remaining),
  );
}

function pauseTimer(n: Notif): void {
  const t = timers.get(n.id);
  if (t) {
    clearTimeout(t);
    timers.delete(n.id);
  }
  if (n.startedAt) {
    n.remaining = Math.max(0, n.remaining - (Date.now() - n.startedAt));
    n.startedAt = 0;
  }
}

function pauseAll(): void {
  for (const n of items) {
    pauseTimer(n);
  }
}

function resumeAll(): void {
  if (shouldPause()) {
    return;
  }
  for (const n of items) {
    startTimer(n);
  }
}

function ensureVisibilityListener(): void {
  if (visListenerBound) {
    return;
  }
  visListenerBound = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      resumeAll();
    } else {
      pauseAll();
    }
  });
}

// DOM setup, created once and reused.
function ensureRoot(): void {
  if (root) {
    return;
  }

  root = document.createElement("div");
  root.className = "notif-stack";

  cardsEl = document.createElement("div");
  cardsEl.className = "notif-cards";
  root.appendChild(cardsEl);

  const closeAll = document.createElement("button");
  closeAll.className = "notif-close-all";
  closeAll.setAttribute("aria-label", "Dismiss all");
  closeAll.innerHTML = CLOSE_SVG;
  root.appendChild(closeAll);

  root.addEventListener("click", handleClick);
  document.body.appendChild(root);
}

function teardownRoot(): void {
  if (!root) {
    return;
  }
  root.removeEventListener("click", handleClick);
  removeOutsideListeners();
  root.remove();
  root = null;
  cardsEl = null;
}

function handleClick(e: MouseEvent): void {
  const t = e.target as HTMLElement;

  if (t.closest(".notif-close-all")) {
    e.stopPropagation();
    dismissAll();
    return;
  }

  const closeBtn = t.closest(".notif-card-close");
  if (closeBtn) {
    e.stopPropagation();
    dismiss(Number((closeBtn as HTMLElement).dataset.id));
    return;
  }

  const actionBtn = t.closest(".notif-action");
  if (actionBtn) {
    e.stopPropagation();
    const card = actionBtn.closest<HTMLElement>(".notif-card");
    if (card) {
      const id = Number(card.dataset.id);
      const n = items.find((x) => x.id === id);
      n?.action?.onClick();
    }
    return;
  }

  // Click on cards area expands the stack (only collapsed, multiple items, not on links)
  if (
    !expanded &&
    items.length > 1 &&
    t.closest(".notif-cards") &&
    !t.closest("a")
  ) {
    expandStack();
  }
}

function createCardEl(n: Notif): HTMLElement {
  const card = document.createElement("div");
  card.className = "notif-card notif-enter";
  card.dataset.id = String(n.id);

  const icon = document.createElement("div");
  icon.className = "notif-icon";
  icon.innerHTML = n.icon;
  if (n.iconBackground) {
    icon.style.background = n.iconBackground;
  }
  card.appendChild(icon);

  const textArea = document.createElement("div");
  textArea.className = "notif-text";

  const title = document.createElement("span");
  title.className = "notif-title";
  title.textContent = n.label;
  textArea.appendChild(title);

  if (n.deeplink !== undefined && n.deeplink !== "") {
    const a = document.createElement("a");
    a.href = n.deeplink;
    a.target = "_blank";
    a.rel = "noopener";
    a.className = "notif-body";
    a.textContent = n.text;
    textArea.appendChild(a);
  } else {
    const s = document.createElement("span");
    s.className = "notif-body";
    s.textContent = n.text;
    textArea.appendChild(s);
  }
  card.appendChild(textArea);

  if (n.action) {
    const actionBtn = document.createElement("button");
    actionBtn.className = "notif-action";
    actionBtn.textContent = n.action.label;
    card.appendChild(actionBtn);
  }

  const close = document.createElement("button");
  close.className = "notif-card-close";
  close.dataset.id = String(n.id);
  close.setAttribute("aria-label", "Dismiss");
  close.innerHTML = CLOSE_SVG;
  card.appendChild(close);

  card.addEventListener(
    "animationend",
    () => {
      card.classList.remove("notif-enter");
    },
    { once: true },
  );

  return card;
}

function updateLayout(): void {
  if (!root || !cardsEl || !items.length) {
    return;
  }

  root.classList.toggle("expanded", expanded);

  const active = items.filter((n) => !n.leaving);
  const visible = expanded ? active : active.slice(-MAX_STACK);

  for (const n of items) {
    if (n.leaving) {
      continue;
    }
    n.el.classList.toggle("notif-hidden-card", !visible.includes(n));
  }

  for (let i = 0; i < visible.length; i++) {
    const stackIdx = expanded ? 0 : visible.length - 1 - i;
    visible[i].el.style.setProperty("--i", String(stackIdx));
  }

  cardsEl.style.cursor = !expanded && active.length > 1 ? "pointer" : "";

  // Hide stack close-all when only one notification; show per-card close instead
  const closeAllBtn = root.querySelector(".notif-close-all");
  if (closeAllBtn) {
    (closeAllBtn as HTMLElement).style.display =
      active.length > 1 ? "" : "none";
  }
  root.classList.toggle("single", active.length <= 1);
}

function hideCloseAll(): void {
  if (!root) {
    return;
  }
  const btn = root.querySelector(".notif-close-all");
  if (btn) {
    (btn as HTMLElement).style.display = "none";
  }
}

function dismiss(id: number): void {
  const n = items.find((x) => x.id === id);
  if (!n || n.leaving) {
    return;
  }

  n.leaving = true;
  pauseTimer(n);
  n.onDismiss?.();

  // Hidden cards (beyond stack limit) are removed immediately
  if (n.el.classList.contains("notif-hidden-card")) {
    n.el.remove();
    items.splice(items.indexOf(n), 1);
    afterRemoval();
    return;
  }

  // If this is the last active card, hide close-all button immediately
  const remaining = items.filter((x) => !x.leaving);
  if (!remaining.length) {
    hideCloseAll();
  }

  n.el.classList.add("notif-leave");
  n.el.addEventListener(
    "animationend",
    () => {
      n.el.remove();
      const idx = items.indexOf(n);
      if (idx >= 0) {
        items.splice(idx, 1);
      }
      afterRemoval();
    },
    { once: true },
  );
  updateLayout();
}

function dismissAll(): void {
  const active = items.filter((n) => !n.leaving);
  if (!active.length) {
    return;
  }

  pauseAll();
  removeOutsideListeners();
  hideCloseAll();

  let pending = active.length;

  for (const n of active) {
    n.leaving = true;
    n.onDismiss?.();
    n.el.classList.add("notif-leave");
    n.el.addEventListener(
      "animationend",
      () => {
        n.el.remove();
        if (--pending <= 0) {
          items.length = 0;
          expanded = false;
          teardownRoot();
        }
      },
      { once: true },
    );
  }
}

function afterRemoval(): void {
  if (!items.length) {
    expanded = false;
    teardownRoot();
    return;
  }
  if (expanded && items.length <= 1) {
    expanded = false;
    resumeAll();
  }
  updateLayout();
}

function onClickOutside(e: MouseEvent): void {
  if (!expanded || !root) {
    return;
  }
  if (!root.contains(e.target as Node)) {
    collapseStack();
  }
}

function onWindowBlur(): void {
  if (expanded) {
    collapseStack();
  }
}

function addOutsideListeners(): void {
  document.addEventListener("click", onClickOutside, true);
  window.addEventListener("blur", onWindowBlur);
}

function removeOutsideListeners(): void {
  document.removeEventListener("click", onClickOutside, true);
  window.removeEventListener("blur", onWindowBlur);
}

function expandStack(): void {
  expanded = true;
  pauseAll();
  updateLayout();
  if (cardsEl) {
    cardsEl.scrollTop = cardsEl.scrollHeight;
  }
  addOutsideListeners();
}

function collapseStack(): void {
  expanded = false;
  removeOutsideListeners();
  resumeAll();
  updateLayout();
}

// Browser Notification, used as a supplement when the tab is hidden.
function fireBrowserNotification(
  text: string,
  deeplink: string | undefined,
  label: string,
): void {
  if (!("Notification" in window)) {
    return;
  }

  const show = (): void => {
    const n = new Notification(label, { body: text });
    n.onclick = () => {
      window.focus();
      if (deeplink !== undefined && deeplink !== "") {
        window.open(deeplink, "_blank");
      }
    };
    setTimeout(() => {
      n.close();
    }, 5000);
  };

  if (Notification.permission === "granted") {
    show();
  } else if (Notification.permission !== "denied") {
    void Notification.requestPermission().then((p) => {
      if (p === "granted") {
        show();
      }
    });
  }
}

export function showNotification(params: NotificationParams): void {
  const text = sanitizeText(params.text);
  if (!text) {
    return;
  }
  const deeplink = validateDeeplink(params.deeplink);
  const dismissMs = params.dismissMs ?? NOTIFICATION_DISMISS_MS;
  const useBrowserNotif = params.browserNotification ?? true;

  ensureVisibilityListener();
  ensureRoot();

  const id = nextId++;
  const item: Notif = {
    id,
    text,
    deeplink,
    label: params.label,
    icon: params.icon ?? BELL_SVG,
    iconBackground: params.iconBackground ?? "",
    remaining: dismissMs,
    startedAt: 0,
    el: undefined as unknown as HTMLElement,
    leaving: false,
    onDismiss: params.onDismiss,
    action: params.action,
  };
  item.el = createCardEl(item);

  items.push(item);
  if (cardsEl) {
    cardsEl.appendChild(item.el);
  }
  updateLayout();
  startTimer(item);

  if (useBrowserNotif && document.visibilityState !== "visible") {
    fireBrowserNotification(text, deeplink, params.label);
  }
}

/** @deprecated Use {@link showNotification} instead. */
export const showPushNotification = showNotification;
