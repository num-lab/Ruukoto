import type { PersonalCliIO } from "./personal-cli.ts";
import { configurePersonalIm } from "./personal-im-cli.ts";

export async function configurePersonalQq(io: PersonalCliIO, directory: string) {
  await configurePersonalIm(io, directory, "qq");
}
