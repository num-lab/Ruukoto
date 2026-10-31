# Agent Note: Demo input keys and text preview

Status: implemented

## Problem

After the production migration, the owner requested another mutable-Demo iteration for send shortcuts, text preview, and workspace-filter transitions. [Inspector preview](2026-10-16-demo-inspector-tools.md) originally displayed plain text; splitting highlighted HTML by line broke multiline comment spans. Unmounting the filter immediately prevented its closing animation.

## Decision

Enter sends and Shift+Enter preserves native newline insertion. Composition input, key code 229, and repeated keydown do not submit. Enter on empty input only prevents a newline; it does not call `send`, which also owns stop behavior. Offline and verification-in-progress submission restrictions remain.

Demo declares `highlight.js` 11.12.0 directly and registers only languages needed by existing samples, including XML for JSX. File extensions select the language; unknown extensions stay plain text. The [highlight API](https://highlightjs.readthedocs.io/en/latest/api.html#highlight) receives raw source and returns escaped highlighted HTML. Only that output enters HTML rendering, never unescaped source. Highlight the entire file once. A sticky line-number column and a single pre/code block share one scroller, preserving characters, blank lines, and newlines. Local semantic syntax-color variables follow light/dark mode without changing the Neutral base palette.

The filter shell stays mounted and transitions grid height, opacity, and slight displacement without an animation dependency. Collapsed content is inert and aria-hidden. Expanding focuses the input; Escape clears the filter and returns focus to the trigger. Reduced motion follows global rules.

These decisions originally applied only to the mutable Demo; production history, context, and isolation contracts were unchanged. Frozen drafts and production migration required separate owner approval. Later Desktop migrations retain their own scope.

## Alternatives considered

Registering and autodetecting every language broadens coverage but increases bundle size and false detection; extension-selected sample grammars suffice. Splitting highlighted HTML by newline resembles the old layout but breaks multiline token tags. Conditional mounting uses less DOM but cannot animate closing; a persistent shell with isolated focus works.

## Consequences

Source readability and key behavior meet the requested interaction. The original change adds a Demo-only dependency; unknown languages remain fully readable. Historical tests and experience records are in the offline copy of `.scratch/desktop-shadcn/issues/06-input-preview-refinement.md`. Real system IME behavior and final motion feel require owner confirmation.
