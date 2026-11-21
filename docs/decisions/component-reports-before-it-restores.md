# A component reports an empty state before it restores

A developer works with a component that boots asynchronously and reports its state to the layer above. On boot it
first reports an empty state, such as signed out, and only later reports what it restored from storage. In that gap
the layer above shows the empty state, which flashes in the display, clears anything derived from it, and misleads a
watcher that reads the displayed state to decide whether to act. The question is where the gap is fixed: in the watcher,
in a test, or in the layer that shows the component's reports.

## How to resolve

1. Fix it in the layer that shows the component's state. That layer shows the component's reports only once the
   component has restored what it stored.
2. Until then, keep showing what the layer already showed, such as a saved copy, so a report from before the restore
   never replaces it.
3. Leave the watchers and caches that read the displayed state as they are. Do not add a trigger for the restored state
   or act on state the display does not show.
4. Do not change only the test to wait out the gap while the product keeps it.

The owner chose to gate the reports in the layer that shows them, which also removes the flash and the cleared cache,
over patching the watcher that hit the gap or the test that showed it.

## Example

```ts
function createAccountView(core: Core, saved: Account | null) {
  const $account = atom(saved);
  core.onReport((report) => {
    // A report from before the restore would show a stored account as gone.
    if (!report.restored) return;
    $account.set(report.account);
  });
  return { $account };
}
```

Not this:

```ts
// Every report is shown, so the boot's empty report flashes and the watcher
// gets one more trigger to catch the restored account.
core.onReport((report) => $account.set(report.account));
watcher.recheckOn($account, (account) => account !== null);
```

## Cases

- A recheck of an open page landed while a newly booted core still reported signed out before restoring the session,
  so the recheck did nothing and the restored sign-in was never checked. The session layer now shows a core's reports
  only once it has read its stored session. (feat/network-chain-indicators)

Status: active
