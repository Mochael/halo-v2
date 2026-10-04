import * as errore from "errore";

export class SessionBackendError extends errore.createTaggedError({
  name: "SessionBackendError",
  message: "Session storage: $detail",
}) {}

export function decodeSessionJson<T>(payload: string): T {
  // SAFETY: These payloads are written from Pi's typed values by this backend and read under the same schema version.
  return JSON.parse(payload) as T;
}
