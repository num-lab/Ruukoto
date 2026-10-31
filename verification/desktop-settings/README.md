# Desktop Settings Preview

An independent UI preview of the desktop settings structure: appearance, models, skills, MCP, computer use, web search, Personal connection and archived sessions. Target-specific settings use separate Code and Personal navigation groups.

The preview uses fictional data and changes memory only. Refresh resets it. Pairing, connection tests, file selection, saving and deletion do not call a product backend or modify real settings. The production counterpart is `apps/desktop/src/renderer/settings-dialog.tsx` and its pages.

## Run And Check

From the repository root:

```sh
npm --prefix verification/desktop-settings ci
npm --prefix verification/desktop-settings run dev
npm --prefix verification/desktop-settings run check
```

Open the local address printed by Vite. The check runs TypeScript and a production build; it does not establish real desktop behavior.

## Components

`SettingsShell`, navigation sections/items and `SettingsPage` own navigation and independent content scrolling. Groups, cards and rows provide consistent spacing and dividers. Lists compose those same rows; subpages handle complex settings with a back action. Select, switch, segmented, input and button controls use the shared styles.

Tokens live in `src/styles.css`; pages reuse them rather than defining their own card or row systems. The preview uses native controls, without an additional UI framework.
