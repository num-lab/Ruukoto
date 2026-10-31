# Note Prose And Provenance

Write the intent code cannot show: behavior, ordering, ownership, failures, consequences and tradeoffs. Enforce expressible invariants in types or runtime checks rather than relying only on prose. Name concrete actors and actions, and give each fact one maintained home.

Before shortening, preserve the claims readers need: conditions/order, must/may/never, exceptions, ownership, effects and failure consequences. Implemented notes use current facts; decisions are not planning checklists. Meaningful mechanism names and measured provenance remain searchable.

## Content By Section

- Decision and Consequences establish observable distinctions, rejection, effects, ownership, cancellation and persistence.
- Detailed sections explain non-obvious topology, dependencies and choices, not a code walkthrough.
- Alternatives and Consequences record costs, benefits, deliberate limits and reintroduction conditions.
- Testing and Verification explain why the evidence establishes the requirement, including the limits of mocks and historical measurements.

## Durable References

A reader of the current repository should be able to identify each source without access to the original chat. Replace orphan references such as "decision 7" or "audit C2" with a named note, Issue or stable source. Historical evidence may name its offline archive and original path, but a removed path is not a live link.

Remove review choreography, progress narration, decorative correctness claims and vague placeholders. Keep genuine sequencing, runtime old/new state distinctions, suppression reasons, Issue references, measured limits and explicit historical provenance. Proposed choices must not become delivered facts during editing.

A safe edit preserves obligations rather than making them optional, distinguishes proposals from implementation, and retains the source and conditions of numerical claims. Translate maintained prose under the root language policy; preserve literal quotations and test samples.
