# Writing For Human Readers

Readers build a model from overview to detail. Start with a concise role statement and topology, then explain interactions and state. A list of ten tables or a chain of internal null checks is not an introduction.

## Concept Or Implementation?

Document domain concepts, collaboration and core guarantees: what a work delegation means, which module owns execution, or how an idempotency key prevents duplicate acceptance. Leave local variables, private helper chains, exhaustive exceptions and schema-column lists in code. Keep protocol details only where callers need them.

Explain the standard workflow first. Gather relevant limits and failures under the owning section; a repeated list of things the system does not do obscures what it does. Preserve necessary safety facts without turning each sentence into a disclaimer.

## Layout

Use tables for interfaces and comparisons, Mermaid for core interactions or transitions, and short paragraphs or lists for distinct facts. A diagram should clarify the system, not copy every function call. Use selective emphasis and occasional callouts for information that changes a reader's next action.

One physical line per paragraph is a source-format rule, not an excuse for a wall of text. Break independent ideas into separate paragraphs.

## Vocabulary And Review

Follow `CONTEXT.md`; retain exact states, event names and code symbols so readers can search them. Use repository-relative paths inside documents. Before finishing, ask whether the normal operation is clear, essential limits appear once in the right place, and deeper implementation detail is linked rather than repeated.
