# Agent Note: Pin a dedicated directory and host environment for Personal commands

Status: implemented

[Command/service configuration versions](2026-10-25-personal-execution-configuration-versions.md) supersedes permanent binding and validation of all history against current configuration. Other permission, identity, and deployment boundaries remain.

[Operation-specific checks](../bug-fix/2026-10-24-operation-specific-checks.md) removes protected-tree scans from full-access runtime operations. Cold enablement, directory/machine/TMPDIR identity, and restricted execution rules remain.

## Problem

The [single-command host](2026-10-17-personal-command-execution.md) accepts trusted launch inputs, but Personal durable profiles lacked a persistent command directory/configuration. Letting a model choose a path, or reselecting one after restart, would expand authority and prevent verification of original execution evidence.

## Decision

With the backend stopped and profile locked, the owner chooses an existing dedicated directory. Configuration records a version, realpath/dev/ino, local machineId, and actual TMPDIR. First enablement validates durable business formats and unresolved inputs/tasks, refusing to save while any remain. The original configuration is immutable. Reads and execution preparation recheck its directory, machine, and TMPDIR identities; changes preserve the profile and reject use. Later versioned-configuration rules govern replacement without reinterpreting old work.

Personal commands use a self-contained worker with an empty runtime-dependency list. Profile data, service source, legacy product profiles, and known credential directories are protected. Shared protected-root validation rejects a granted directory inside or containing a protected root. Evidence goes only to the profile's exact `commands` directory, a private ordinary subdirectory. Symlinks and permissive modes are rejected; reacquiring the lock retains 0700 without recursively rewriting evidence.

[Full-access commands](2026-10-17-personal-full-access-commands.md) supersedes the original lack of full-access wiring, not restricted execution, existing host evidence, or stop protocol. [Host execution](2026-10-17-personal-command-execution.md) retains receipt/temp ownership, [service configuration](2026-10-17-personal-service-configuration.md) shares stopped/locked first enablement, and [the worker](2026-10-17-personal-command-worker.md) owns bundling and empty dependencies.

## Alternatives considered

A model-supplied path is a small tool interface but cannot establish owner authority or stable recovery identity. Using the backend profile as cwd avoids separate configuration but lets commands write permissions, sessions, control credentials, and evidence. The original immutable-directory policy rejected offline directory switching because old work still bound the original directory/intent; later versioning explicitly replaces that restriction rather than silently rebinding history.

## Consequences

The model need not handle directory identities or permission versions. Recovery still requires the original directory, machine, and TMPDIR for the bound work. The original policy required a new profile for moving hosts/directories; later configuration-version decisions own supported replacements. Configuration alone proves neither Linux isolation nor service deployment. Durable command work still owns execution and unknown effects; this configuration does not itself provide full-access commands or out-of-scope approval.
