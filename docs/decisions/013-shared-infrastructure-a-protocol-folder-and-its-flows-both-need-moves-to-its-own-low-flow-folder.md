# D-013: When flows need shared infrastructure that sits in the folder owning an external protocol's side, that infrastructure moves to its own low flow folder, a wrapper a flow needs comes in as a parameter, and a mixed folder splits into a low and a high part

- Situation: an app is grouped by flow, and one flow folder owns an external protocol's side and imports the flows it
  serves, which never import it at runtime (D-009). Some flows still need infrastructure that sits in that folder and
  that is not the protocol's own: shared connection infrastructure the whole page uses (a pool of connections, their
  providers, a content-fetch client, reads of another network) and a wrapper around the protocol's core connection. The
  imports then form cycles. The question is how the cycles are broken.
- Options:
  - A: untangle along D-009. The shared infrastructure moves out of the protocol-owning folder into its own low flow
    folder that any flow may read. The protocol folder keeps only the callbacks it answers the remote side with. A flow
    receives the core-connection wrapper as a parameter, with the core lease it already gets that way, instead of
    importing it. A folder that mixes a low part other flows read with a high part that sits above the runtime, such as
    a debug mode and its wire frames beside a debug panel, splits into a low folder and a high folder. A metric moves to
    the module that counts it.
  - B: fix only the modules that read an import at load time, and leave the cycles.
  - C: stop the cycle work.
- Owner: option A. "Untangle along D-009 (Recommended)".
- Why: the owner gave no reason beyond choosing the option offered as recommended. As offered, it keeps D-009's one-way
  runtime imports, so the cycles end in the structure instead of in load order.
- Applies when:
  - an app is grouped by flow under D-009, and flows need something that sits in the protocol-owning folder, so they
    would have to import it at runtime
  - the thing they need is shared infrastructure the page uses beyond the protocol's callbacks: it moves to its own low
    flow folder that any flow, the protocol folder included, may import
  - the thing they need is a wrapper around something the flow already receives as a parameter: it comes in beside that
    parameter instead of through an import
  - a folder holds both a low part other flows read and a high part that sits above the runtime: it splits into a low
    folder and a high folder, so each sits on one side of the runtime
  - a metric sits in a module other than the one that counts it: it moves to the counting module
- Not when: no case yet.
- Source: the change that regroups the host, sandbox and protocol apps by flow, design
  `docs/_plans/app-flow-folders-design.md`.
- Status: active. It narrows D-009, whose protocol-owning folder keeps only the access it answers the remote side with.
