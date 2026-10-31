# Archiving And Retention

Use this during supersession or a milestone cleanup; ordinary changes update nearby owning notes rather than rescanning the entire tree. New notes still require an immediate search and classification of relevant active records.

## Keep, Archive Or Delete

Judge future decision value, not age or length. Keep active records that constrain ownership, authorization, safety, deliberate capability limits or tempting but dangerous alternatives. An obsolete implementation detail is not the same as an obsolete guarantee.

Archive a completed implemented record whose rationale no longer guides current work but still deserves historical retention, such as a closed narrow UI adjustment or retired adapter. When fully superseding a note, first preserve all unique durable constraints in the new active note; remove the old one if nothing distinct remains, otherwise archive the historical record. Partial supersession leaves both active and linked.

Proposals are never archived. If their premise disappears or work is abandoned, reject them with a concrete reason when it still prevents a mistake; otherwise delete them. Rejected records can be removed when their obsolete technology makes the rejected path no longer plausible.

## Command

Run at the repository root:

```sh
npx tsx .agents/skills/maintain-notes/scripts/archive-agent-note.ts <note-path> [--superseded-by <new-note-path>]
```

The command inserts an `Archived: yyyy-mm-dd` header after `Status: implemented`, moves the file from implemented to archived, records SHA-256 in `archived/manifest.json`, and reports active inbound Markdown links. No other byte of the archived body changes. With `--superseded-by`, it adds the historical link to the new note, not the archived one. It works without Git.

For older unsealed archives, `npx tsx .agents/skills/maintain-notes/scripts/verify-archived-agent-notes.ts --write` validates existing seals before adding missing entries. It does not rewrite existing history.

## Permanent Seal

Archived records are never edited, translated, reformatted, moved or deleted. Validation checks header layout, manifest hashes and append-only seals against `AGENT_NOTE_ARCHIVE_BASE_REF` (default `HEAD`). Without Git it reports that only hash self-validation is available. The normal tree/format/link scans exclude archives as sources; historical outgoing links may be obsolete. Current behavior is established by active implemented notes and source, not sealed records.

Retention method: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
