import { isDeepStrictEqual } from "node:util";
import { invalid, object, readSnapshot, singleton, unsupported } from "./profile-predecessor-durable-records.ts";
import { inspectResources } from "./profile-predecessor-durable-resources.ts";

const legacy = { product: "ruukoto", format: 1, pi: "1.3.0", extensions: { personal: 2 } };
const configured = { ...legacy, configuration: 1 };

/** Recognizes only the two archived manifests; an interrupted configuration conversion is not a stopped profile. */
export function validateDurableManifest(manifest: unknown): void {
  const value = object(manifest);
  if (value.configurationMigration !== undefined) unsupported("in-progress configuration conversion");
  if (!isDeepStrictEqual(value, legacy) && !isDeepStrictEqual(value, configured)) unsupported("manifest shape or version");
}

/** The caller holds predecessor exclusion and supplies a coherent private copy, never the original database. */
export function inspectDurablePredecessor(copyDatabasePath: string, manifest: unknown): void {
  validateDurableManifest(manifest);
  const snapshot = readSnapshot(copyDatabasePath), format = singleton(snapshot, "ruukoto.format");
  if (!format || !isDeepStrictEqual(format, manifest)) invalid("manifest and database agreement");
  inspectResources(snapshot);
}
