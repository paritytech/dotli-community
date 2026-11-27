# One read serves callers whose sources differ in trust

A package's read takes a source from its caller and checks what the source returns, such as hashing each block against
its id. Two callers share the read, or two entry points merge into one, and their sources differ in trust. One source
was already checked upstream, so the caller needs only a light check, such as the root alone. The other may bypass that
upstream, so every item must be checked. The package already exports a wrapper for each level of check. The question is
whether the read picks the check from a parameter naming the source's trust, always runs the full check, or checks
nothing itself.

## How to resolve

1. Keep the check out of the shared read. It reads from the source it is given and trusts what that source returns.
2. Export each level of check as a wrapper around a source, such as one that checks every item and one that checks only
   the root.
3. Let each caller wrap its own source with the wrapper that fits what it knows about that source, and pass the wrapped
   source to the read.
4. Add no parameter that names the source's trust to the read, and no fixed full check that makes an upstream-checked
   caller pay twice.

The owner chose this without stating a reason. The caller is the one that knows where its source comes from, and the
wrappers already exist, so the read stays one plain walk.

## Example

```ts
// a caller whose items a trusted relay already checked
const items = await readGraph(checkRootOnly(relaySource, rootId), rootId);

// a caller whose source may bypass the relay
const items = await readGraph(checkEveryItem(directSource), rootId);
```

Not this:

```ts
await readGraph(source, rootId, { trust: 'relay' }); // the read picks the check
await readGraph(source, rootId); // always checks every item, the relay's caller checks twice
```

## Not when

The shared read also stores a newer copy of what it fetches, and its consumers differ in whether they can confirm that
copy themselves. The store decision then stays with the storage package in a named reader per consumer rather than
moving to every caller, as
[shared-reader-whose-consumers-confirm-copies-differently](shared-reader-whose-consumers-confirm-copies-differently.md)
says. The two rules agree that no parameter names the difference.

## Cases

- A domain-free content package walked a content graph from a caller's block source. An isolated app's page load got
  its blocks through a parent page's relay that had hashed them all, so it re-hashed only the root. The parent page's
  own background reads could bypass the relay, so every block was hashed. Merging the two entry points into one read,
  offered a trust parameter, the caller wrapping its own source, or a full hash every time, the owner chose that each
  caller wraps its source. (docs/\_plans/worker-chat-design.md, archive extension of the worker-chat change)

Status: active
