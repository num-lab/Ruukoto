import { PersonalError } from "./personal-error.ts";

export class PersonalImApiError extends PersonalError {
  constructor(code: string, message: string, readonly effect: "not_sent" | "effect_unknown", readonly retryAfterMs?: number) { super(code, message); }
}
