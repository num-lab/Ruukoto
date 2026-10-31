# Agent Note: Read folders before expanding them

Status: implemented

[Directory paging and lazy Git](2026-10-24-directory-pages-lazy-git.md) removes Git detection and its error area from new tabs and keeps entry points visible. Folder-loading feedback remains.

## Problem

Initial file-tree reads and each folder expansion inserted loading text as content rows. Empty-directory messages, new-tab detection text, and diff lists caused further layout changes.

## Decision

The root's first read shows an accessibly named loading icon. Clicking a folder stores intent in the existing `folders` state and starts `loadDirectory` directly. Actual expansion waits for a directory value or error. While reading, the icon sits at the end of the folder row and the arrow stays collapsed. A second click cancels expansion intent, but the completed response may still populate the cache. Cache hits expand immediately. Refresh preserves old content and expansion with a loading icon. Failure expands an error and retry action; retry waits again. Empty roots and folders remain blank, without a no-files message.

The original new-tab simplification retained browser, file-tree, Git, and SubAgent entry points, removed Git-detection text and diff lists, and retained retryable detection failures. The later directory-paging decision supersedes detection itself. Inline diff entry points and open diff tabs remain usable. Demo uses synchronous samples rather than simulated delays, with matching new-tab and empty-tree presentation.

This supplements [file-tree refresh](../bug-fix/2026-10-17-desktop-file-tree-refresh.md): read permissions, cache generations, and refresh intervals remain. It narrows new-tab presentation from the [inspector expansion](2026-10-16-demo-inspector-tools.md).

## Alternatives considered

Immediate expansion with a child loading icon needs fewer changes but still inserts an extra content row. Reading only after child Directory mounts retains the old structure but cannot also delay expansion, so reading starts on the click. Leaving failures collapsed hides recovery; empty-folder text was explicitly rejected by the owner.

## Consequences

Loading adds no temporary child items, while errors and retry remain visible. Expansion intent differs from actual open state, and automatic refresh still scans intent. Canceling intent does not revoke an already issued read-only request. Component regressions and browser acceptance scope are recorded in the offline copy of `.scratch/desktop-shadcn/issues/23-files-sidebar.md`.
