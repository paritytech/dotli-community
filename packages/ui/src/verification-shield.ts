// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li verification shield: a real button in the URL pill that toggles the
// "How was this site loaded?" explainer, with one glyph per state.

/** "verified" = the visitor's light client checked it, "trusted" = an RPC provider did. */
export type ShieldState = "verified" | "trusted";

export const VERIFICATION_SHIELD_ID = "verification-shield";
export const VERIFICATION_TOOLTIP_ID = "verification-tooltip";

const SHIELD_STATES: readonly ShieldState[] = ["verified", "trusted"];

const TOOLTIP_TITLE = "How was this site loaded?";

const SHIELD_OUTLINE =
  "M12 2L3 7v5c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-9-5z";

// Material "gpp_good" / "gpp_maybe" vocabulary: a check for verified, an
// exclamation mark for "protected, but take note". Both cut out of one fill.
const GLYPH_PATHS: Record<ShieldState, string> = {
  verified: `${SHIELD_OUTLINE}m-1 14.59l-3.29-3.3 1.41-1.41L11 13.76l4.88-4.88 1.41 1.41L11 16.59z`,
  trusted: `${SHIELD_OUTLINE}M11 7.5h2v6h-2zM11 15.5h2v2h-2z`,
};

const COPY: Record<
  ShieldState,
  { label: string; description: string; buttonLabel: string }
> = {
  verified: {
    label: "Verified",
    description: "More secure, checked by your light client.",
    buttonLabel: "Verified via light client",
  },
  trusted: {
    label: "Trusted",
    description: "Served by an external RPC provider.",
    buttonLabel: "Loaded from a trusted provider",
  },
};

function shieldIcon(state: ShieldState, className: string): string {
  return `<svg class="${className} is-${state}" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-hidden="true" focusable="false"><path d="${GLYPH_PATHS[state]}"/></svg>`;
}

function tooltipRow(state: ShieldState): string {
  const { label, description } = COPY[state];
  return `<div class="verification-tooltip-row" data-state="${state}">${shieldIcon(state, "verification-tooltip-icon")}<span class="verification-tooltip-text"><span class="verification-tooltip-name"><strong class="verification-tooltip-label">${label}</strong><span class="verification-tooltip-current">This site</span></span><span class="verification-tooltip-desc">${description}</span></span></div>`;
}

/** Shield and explainer markup for the URL pill. Bind it once it is in the DOM. */
export function verificationShieldMarkup(): string {
  const icons = SHIELD_STATES.map((state) =>
    shieldIcon(state, "verification-shield-icon"),
  ).join("");
  const rows = SHIELD_STATES.map(tooltipRow).join("");
  return `<div class="verification-shield-wrap"><button type="button" id="${VERIFICATION_SHIELD_ID}" class="verification-shield" aria-label="${TOOLTIP_TITLE}" aria-expanded="false" aria-controls="${VERIFICATION_TOOLTIP_ID}">${icons}</button><div class="verification-tooltip" id="${VERIFICATION_TOOLTIP_ID}"><div class="verification-tooltip-title">${TOOLTIP_TITLE}</div>${rows}</div></div>`;
}

/** Wire the disclosure toggle. Returns the unbind, which only tests need. */
export function bindVerificationShield(): () => void {
  const button = document.getElementById(VERIFICATION_SHIELD_ID);
  const panel = document.getElementById(VERIFICATION_TOOLTIP_ID);
  const wrap = button?.closest<HTMLElement>(".verification-shield-wrap");
  if (
    button === null ||
    panel === null ||
    wrap === null ||
    wrap === undefined
  ) {
    return () => undefined;
  }
  const controller = new AbortController();
  const { signal } = controller;

  const isOpen = (): boolean => panel.classList.contains("open");
  const setOpen = (open: boolean): void => {
    panel.classList.toggle("open", open);
    button.setAttribute("aria-expanded", String(open));
  };

  button.addEventListener(
    "click",
    () => {
      setOpen(!isOpen());
    },
    { signal },
  );

  // Clicks on the wrap are excluded so a toggle never closes what it just
  // opened, and a tap on the panel itself leaves it up.
  document.addEventListener(
    "click",
    (e) => {
      if (isOpen() && !wrap.contains(e.target as Node)) {
        setOpen(false);
      }
    },
    { signal },
  );

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !isOpen()) {
        return;
      }
      setOpen(false);
      // Safari leaves focus on body after a pointer click, so hand it back
      // to the trigger in that case too. Focus elsewhere in the bar stays.
      const active = document.activeElement;
      if (active === document.body || wrap.contains(active)) {
        button.focus();
      }
    },
    { signal },
  );

  // A tap inside the product iframe never reaches this document, but it does
  // move focus out of the window, which is the cue to dismiss.
  window.addEventListener(
    "blur",
    () => {
      if (isOpen()) {
        setOpen(false);
      }
    },
    { signal },
  );

  window.addEventListener(
    "dotli:blocking-modal-active",
    (e: Event) => {
      if ((e as CustomEvent<{ active: boolean }>).detail.active) {
        setOpen(false);
      }
    },
    { signal },
  );

  return () => {
    controller.abort();
  };
}

/** Swap the glyph, colour, label and the "This site" row to match `state`. */
export function setVerificationShieldState(state: ShieldState): void {
  const button = document.getElementById(VERIFICATION_SHIELD_ID);
  if (button === null) {
    return;
  }
  for (const candidate of SHIELD_STATES) {
    button.classList.toggle(candidate, candidate === state);
  }
  button.setAttribute(
    "aria-label",
    `${COPY[state].buttonLabel}. ${TOOLTIP_TITLE}`,
  );
  const rows = document
    .getElementById(VERIFICATION_TOOLTIP_ID)
    ?.querySelectorAll<HTMLElement>(".verification-tooltip-row");
  rows?.forEach((row) => {
    row.classList.toggle("is-current", row.dataset.state === state);
  });
}
