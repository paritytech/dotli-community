# A window blur closes a light-dismiss popover

A shared floating layer closes an open popover when the window loses focus, because a press inside an embedded
cross-origin iframe reaches the page only as a window `blur`. A developer notices the popover also closes when the
browser takes focus with its own UI, such as while the page reloads an embedded frame, or when the user switches to
another app. Focus is still on the element inside the popover in those cases. The question is which window blurs should
close it, and whether the fix belongs in the shared layer or in the one feature that is hurt.

## How to resolve

1. Fix it in the shared layer, not with handling in the feature that is hurt.
2. On a window `blur`, read the document's active element.
3. Close the popover only when that element is an iframe outside the popover, which means the press went into an
   embedded app.
4. Leave the popover open for any other blur, such as one to the browser's own UI or to another app, as a native
   light-dismiss popover stays open.

The owner chose to close only on a blur into the embedded app, without stating more of a reason. The option chosen
matches how a native light-dismiss popover behaves.

## Example

```ts
// Before: every blur closes.
window.addEventListener('blur', () => closeLayer());

// After: only a press into an embedded frame outside the layer closes.
window.addEventListener('blur', () => {
  const active = document.activeElement;
  if (active instanceof HTMLIFrameElement && !layerElement.contains(active)) {
    closeLayer();
  }
});
```

## Cases

- A shared UI package's floating layer closed a popover on every window blur, so a browser taking focus while the page
  reloaded an embedded frame closed it too. It now closes only when the blur went into an iframe outside the popover.
  (PR #484, branch `feat/browser-device-permissions`)

Status: active
