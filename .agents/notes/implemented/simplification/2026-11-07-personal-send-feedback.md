# Agent Note: Personal send feedback stays beside the owner bubble

Status: implemented

## Problem

Routine processing and admission text duplicates message feedback and crowds the composer. Waiting for the native host's first pending event also delays the owner's visible bubble after clicking Send.

## Decision

For connections with canonical owner display, Send creates a local presentation before waiting for draft writes or the native host. The host-owned request key then binds that presentation at its existing position. An accepted receipt or canonical entry removes its left-hand loading icon; receipt and stream order do not create another bubble. This provisional presentation never claims server admission or supplies a request key to the host.

Do not add routine processing, queuing or admission prose above the Personal composer or inside owner bubbles. Admission uncertainty uses only the loading icon beside the bubble. Explicit errors, incomplete processing and the original-request recovery actions remain available. This replaces the routine presence and admission wording in the [desktop file loop](../feature/2026-11-04-personal-desktop-file-loop.md).

Legacy history without request keys retains its history-only fallback. It cannot support a persistent immediate bubble while also proving that an unassociated user entry is the same input. Text, arrival order and timestamps are not message identity.

## Alternatives considered

Waiting for a host event avoids a separate in-flight presentation but delays visible feedback. Matching legacy history by text or order would provide an apparent handoff but can merge another client's input or two identical real submissions, so the client keeps the authoritative history fallback.

## Consequences

Canonical connections show feedback immediately, including attachment-only sends. Known rejection or a connection change removes the temporary presentation while retaining the draft. Lost results continue to use the host's durable original request and existing reconciliation; no new request is submitted automatically. Legacy connections need canonical owner display before immediate bubbles can be offered reliably.
