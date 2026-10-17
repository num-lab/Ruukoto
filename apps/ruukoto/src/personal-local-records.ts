import { createHash } from "node:crypto";
import { defineDocFamily, type TaskId } from "@earendil-works/pi-durable";

export const LocalInputDoc = defineDocFamily<{ digest: string; work?: TaskId }, string>({ kind: "ruukoto.local-input", scope: "session", version: 1, family: true, initial: (digest: string) => ({ digest }) });

export const personalInputDigest = (input: string, work?: TaskId) => createHash("sha256").update(JSON.stringify(work === undefined ? input : [input, work])).digest("hex");
