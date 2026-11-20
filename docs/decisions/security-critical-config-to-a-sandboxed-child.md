# Delivering security-critical config to a sandboxed child

A sandboxed child frame reads its config from its parent, and one of those values is security-critical: the child must
be sure it came from its real parent and not from whoever embedded the frame. Today the parent passes the config as URL
params, but any embedder can write that URL, so the child cannot trust the value or bind it to the one that created the
frame. The question is how the parent should hand the config over, and whether only the sensitive value or the whole set
moves.

## How to resolve

1. Replace the parent-written URL params with a request-reply handshake: at boot the child asks its direct parent for
   its config.
2. The child accepts the reply only from its direct parent at the trusted origin. The parent replies only to that
   authenticated frame.
3. Move the whole related set of settings onto the channel, not just the sensitive value, so the child URL carries no
   parent-written params and the initial load and the reload or recover path become one path.

The URL is writable by any embedder, so a value that must be trusted cannot ride on it. An authenticated request-reply
channel binds the config to the real parent. Moving the whole set keeps one delivery path instead of splitting the
config across a channel and a URL with two sets of validation and recovery.

## Example

```
Before: parent builds   child.example/view?item=abc&mode=live&reset=1
        child reads item, mode, reset from its own URL (any embedder could forge them)

After:  child  -> parent   "request-config"      (at boot, and again on reload)
        parent -> child     { item, mode, reset }  posted only to the authenticated child frame,
                                                    accepted only from the parent's trusted origin
        child URL carries no parent-written params; one path serves first load and reload
```

## Cases

- A product sandbox did not authenticate its embedder and bound its content id to its label through URL params. It moved
  the content id and its companion settings (backend, network, reset, version) to a boot handshake
  (fix/sandbox-tenant-isolation-5362, security finding #5362)

Status: active
