// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// happy-dom has no popover API. This covers open state and the two events FloatingLayer listens to. Light dismiss
// and the top layer are tested in the stories lane.

function dispatchToggle(el: HTMLElement, type: 'beforetoggle' | 'toggle', open: boolean): void {
  const ev = new Event(type);
  Object.assign(ev, { oldState: open ? 'closed' : 'open', newState: open ? 'open' : 'closed' });
  el.dispatchEvent(ev);
}

function setOpen(el: HTMLElement, open: boolean): void {
  if (el.hasAttribute('data-popover-open') === open) {
    return;
  }
  dispatchToggle(el, 'beforetoggle', open);
  el.toggleAttribute('data-popover-open', open);
  dispatchToggle(el, 'toggle', open);
}

if (typeof HTMLElement.prototype.showPopover !== 'function') {
  Object.assign(HTMLElement.prototype, {
    showPopover(this: HTMLElement) {
      setOpen(this, true);
    },
    hidePopover(this: HTMLElement) {
      setOpen(this, false);
    },
    togglePopover(this: HTMLElement, force?: boolean) {
      const next = force ?? !this.hasAttribute('data-popover-open');
      setOpen(this, next);
      return next;
    },
  });
}
