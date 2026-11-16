# D-009: In an app grouped by flow, one flow folder owns an external protocol's side whole, its adapters for every callback included, and imports the flows it serves through their `index.ts`

- Situation: an app's source is grouped into one folder per flow. The app answers an external protocol whose callbacks
  are assembled into one callback object, and each callback serves a different flow of the app. The question is where
  the adapters that translate each callback into the app's own calls live, and which way the imports between those
  adapters and the flows run.
- Options:
  - A: each flow owns the adapter for its callbacks, in its own folder. One composition module, in the runtime's
    composition root, imports each flow's adapter and assembles the callback object.
  - B: all adapters stay together in one flow folder that owns the protocol side whole: the core connection, the
    adapters, their assembly and the runtime composition root. It imports the flows through their `index.ts`. Flows
    never import it at runtime. They import only its types, or reach it through a facade passed in as a parameter.
  - C: all adapters stay together in one core folder, and each flow registers a handler with it at startup, so the core
    folder imports no flow.
- Owner: option B. "One productRuntime feature (Recommended)". It was offered as one feature owning "the TrUAPI side
  whole: the core connection, the chain access for products, all the callback adapters, their assembly, and the runtime
  composition root".
- Why: the owner gave no reason beyond choosing the option offered as recommended. As offered, that option lets the
  other flows expose plain actions and stores that know no callback signature, and translates the protocol's wire
  shapes in one place.
- Applies when:
  - an app's source is grouped into one folder per flow, and the app answers an external protocol through callbacks
    that serve different flows
  - the protocol's side goes in one flow folder: its core connection, the chain or network access it gives the remote
    side, every callback adapter, the assembly of the callback object and the runtime composition root. The chain or
    network access here means only the callbacks the folder answers the remote side with. Shared connection
    infrastructure that other flows read lives in its own low flow folder (D-013).
  - that folder imports the other flows only through their `index.ts`, and the other flows expose plain actions and
    stores that know no callback signature or wire shape
  - a flow that needs the protocol side imports only its types, or receives a facade as a parameter. It never imports
    that folder at runtime, so the runtime imports run one way.
- Not when: the infrastructure is shared beyond the protocol's callbacks, such as a pool of connections, their
  providers, a content-fetch client or reads of another network, and other flows need it. It moves to its own low flow
  folder instead, and a wrapper a flow needs comes in as a parameter (D-013).
- Source: the change that regroups the host, sandbox and protocol apps by flow, design
  `docs/_plans/app-flow-folders-design.md`.
- Status: active, narrowed by D-013
