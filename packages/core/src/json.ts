import { createHash } from "node:crypto";

/** Canonical JSON orders object keys recursively while retaining array order for source digests. */
export function canonicalJson(value: unknown): string {
  const sortValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map(key => [key, sortValue(record[key])]));
    }
    return value;
  };
  return JSON.stringify(sortValue(value));
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
