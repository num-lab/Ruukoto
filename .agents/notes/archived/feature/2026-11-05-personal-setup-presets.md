# Agent Note: Personal setup uses installed model presets and three administration groups

Status: implemented
Archived: 2026-11-10

## Problem

Personal setup required owners to enter model capacities manually, even for models already described by the installed SDK. The administration menu mixed chat, capability configuration and recovery in six first-level groups. Permission selection named local and Telegram entries without identifying desktop access or explaining that confirmation still allows operations within granted scope.

## Decision

The model wizard and desktop settings offer compatible chat-model records from the installed OpenAI, Anthropic and DeepSeek catalogs. Presets preserve each record's API, endpoint, context window, maximum output and image-input capability. They use existing environment-variable credentials and pass the same Personal model validator as custom configurations. Records with unsupported APIs or an output limit equal to or larger than their context window are omitted. The installed GPT-Realtime-2.1 record is also omitted because its [official model page](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) does not support the streaming path Personal uses. No network catalog refresh or new authentication method is introduced.

The backend includes this bounded preset list in settings reads. Desktop selection changes only the current draft; explicit save and the existing versioned settings receipts still own publication. Reading an older backend without presets keeps the custom editor. Switching to custom keeps all current fields, and custom endpoint, model, credential reference and all three existing API choices remain editable.

The presets describe installed configuration, not the vendor's largest available window. In particular, the installed OpenAI catalog uses a 272000-token normal-tier window for several models whose official maximum is 1050000. Owners can choose a different supported limit through custom configuration. [OpenAI GPT-4.1](https://developers.openai.com/api/docs/models/gpt-4.1), [OpenAI GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [Anthropic model overview](https://platform.claude.com/docs/en/about-claude/models/overview) and [DeepSeek model details](https://api-docs.deepseek.com/quick_start/pricing) were checked against the installed records. These sources establish different per-model capacities and DeepSeek Flash's image support versus Pro's text-only input; account access and connection success still require explicit testing.

The first administrator screen contains Configuration, Status/Start/Stop and Advanced Management. Existing chat, work, decisions, recovery and data actions stay under Advanced Management without changing their handlers. Configuration includes permission defaults. Desktop connection settings read the same defaults through the paired profile. Labels identify the desktop/local/Telegram shared default and QQ's separate default, explain granted-scope execution in confirmation mode, and retain the full-access confirmation.

Desktop permission requests carry the exact original connection and paired profile. The native host verifies that binding immediately before dispatch; its existing connection-generation check rejects late results after a switch. A save, including a lost response, is followed only by a read of the current defaults. Failed reads clear the displayed values and lock dependent choices until reread; there is no automatic write retry. Page invalidation discards late results, and reopening obtains actual modes from the current profile. This setting changes only future input defaults; it does not reauthorize existing work.

[Local management](../architecture/2026-10-17-personal-local-management.md), [settings queries](2026-10-21-personal-settings.md), [settings versions](../architecture/2026-10-25-personal-settings-versions.md) and [original-entry permissions](../architecture/2026-10-17-personal-telegram-permissions.md) retain ownership of admission, persistence, application and authorization. This decision changes their setup presentation without replacing those contracts.

## Alternatives considered

- Hard-code a capacity for each provider: fewer catalog reads, but misrepresents models with different windows and input capabilities.
- Add a live catalog service: updates independently of dependencies, but adds lifecycle and compatibility work outside this milestone. The installed SDK is the maintained source already shipped with the product.
- Replace terminal chat: could unify the desktop interaction, but the requested administrator grouping only needs to move the existing entries.

## Consequences

Preset metadata follows SDK upgrades and remains subject to Personal's validator. Custom configuration remains necessary for gateways and provider limits that differ from installed defaults. Tests cover per-model values, filtering, bounded metadata, backend settings projection, explicit draft/save behavior, custom API/address/model/credential preservation, menu reachability, permission scope wording, one-shot full-access confirmation, lost-response inspection and changed-profile rejection. Native host builds and real-model acceptance remain integrated issue checks.
