import type { McpExtensionOptions } from "@earendil-works/pi-coding-agent";

type Credentials = NonNullable<McpExtensionOptions["credentials"]>;
const credentials: Pick<Credentials, "forServer" | "tokens" | "remove"> = {
  forServer: () => ({
    load: () => undefined,
    save: () => { throw new Error("OAuth credential writes forbidden"); },
    withRefreshLock: fn => fn(),
  }),
  tokens: () => undefined,
  remove: () => false,
};
const options: McpExtensionOptions = { credentials: credentials as Credentials };
void options;
