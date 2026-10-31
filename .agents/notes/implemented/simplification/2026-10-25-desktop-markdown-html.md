# Agent Note: Render HTML in Desktop Markdown

Status: implemented

## Problem

Desktop Markdown did not parse raw HTML, so ordinary `details` and `summary` content appeared as tag text. On 2026-10-25, after learning the behavior, the owner requested removal of this restriction. Without a raw plugin, Streamdown turns HTML into text before rendering; removing `skipHtml` alone has no effect.

## Decision

The shared `MarkdownText` used by Code main and child conversations, Personal, file previews, and both products' skills parses HTML with Streamdown's exported raw plugin before the existing `rehype-sanitize`. `skipHtml` is removed. Allowed tags render normally; scripts, event attributes, and dangerous links remain filtered. HTML inside code fences remains source text. The mutable Demo follows this behavior; frozen drafts retain their history.

Image schemes and relative addresses, custom links, and code/math/diagram plugins keep their existing handling. No harden plugin, dependency, or configuration option is added. HTML support follows the sanitizer's tag and attribute policy, not arbitrary page-code execution.

This partially supersedes the raw-HTML prohibition in [Streamdown](../feature/2026-10-25-desktop-streamdown.md), [direct images](2026-10-25-desktop-markdown-images.md), [Code Skills](../feature/2026-10-21-desktop-code-skills.md), [Demo inspector tools](../feature/2026-10-16-demo-inspector-tools.md), and the [Desktop proposal](../../proposed/architecture/2026-10-15-desktop-client.md). Other decisions remain. Previewing a standalone HTML file through `present` is a different capability. Original implementation evidence is in the offline copy of `.scratch/code-simplification/issues/02-markdown-html.md`.

## Alternatives considered

Removing only `skipHtml` is the smallest diff but still produces text rather than HTML. Restoring the entire default pipeline reduces custom plugin configuration, but its sanitizer removes file/blob/data image URLs and harden rewrites relative URLs, violating the approved image behavior.

## Consequences

Chats and documents can render HTML disclosure blocks, line breaks, and other allowed elements. Existing dependencies still own filtering. SSR regressions across body entry points verify real HTML elements, dangerous-content filtering, escaped fenced code, and all seven image-address classes.
