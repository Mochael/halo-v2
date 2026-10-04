// oxlint-disable unicorn/no-null -- SQL uses NULL for an absent read receipt.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- Queries project repository-owned tables into matching row types.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { DatabaseClient } from "./DatabaseClient.js";
import type {
  SessionHandle,
  SessionData,
  SessionMetadata,
  SessionProductFields,
  SessionRepoApi,
} from "./SessionRepoApi.js";
import { TursoStorage } from "./TursoStorage.js";
import { decodeSessionJson, SessionBackendError } from "./sessionSchema.js";

type SessionProductFieldsRow = {
  id: string;
  marked_done: number;
  read_receipt_cursor_id: string | null;
};
type MetadataRow = { metadata: string };

export class TursoSessionRepo implements SessionRepoApi {
  private readonly reserved = new Set<string>();
  private readonly storages = new Set<TursoStorage>();
  private closed = false;

  constructor(private readonly database: DatabaseClient) {}

  async create(options?: { id?: string }) {
    const createdAt = Date.now();
    const sessionId = options?.id ?? uuidv7(createdAt);
    this.reserve(sessionId);
    const inserted = await this.database.access((connection) =>
      connection
        .prepare("INSERT INTO halo_sessions (id, metadata) VALUES (?, ?)")
        .run(sessionId, JSON.stringify({ id: sessionId, createdAt })),
    );
    if (inserted instanceof Error) {
      this.reserved.delete(sessionId);
      throw inserted;
    }
    return await this.openReserved({ id: sessionId, createdAt });
  }

  async open(metadata: SessionMetadata) {
    this.reserve(metadata.id);
    const loaded = await this.database.access((connection) => {
      const row = connection
        .prepare("SELECT metadata FROM halo_sessions WHERE id = ?")
        .get(metadata.id) as MetadataRow | undefined;
      if (row === undefined)
        throw new SessionBackendError({
          detail: `Unknown session ${metadata.id}`,
        });
      const persisted = decodeSessionJson<SessionMetadata>(row.metadata);
      return { id: persisted.id, createdAt: persisted.createdAt };
    });
    if (loaded instanceof Error) {
      this.reserved.delete(metadata.id);
      throw loaded;
    }
    return await this.openReserved(loaded);
  }

  async list() {
    this.assertOpen();
    const listed = await this.database.access((connection) =>
      (
        connection
          .prepare("SELECT metadata FROM halo_sessions")
          .all() as MetadataRow[]
      )
        .map(({ metadata }) => decodeSessionJson<SessionMetadata>(metadata))
        .map(({ id, createdAt }) => ({ id, createdAt }))
        .toSorted((a, b) => b.createdAt - a.createdAt),
    );
    if (listed instanceof Error) throw listed;
    return listed;
  }

  async read(sessionId: string): Promise<SessionData> {
    this.assertOpen();
    return await TursoStorage.readSession({
      database: this.database,
      sessionId,
    });
  }

  async listProductFields() {
    return await this.database.access(
      (connection) =>
        new Map<string, SessionProductFields>(
          (
            connection
              .prepare(
                "SELECT id, marked_done, read_receipt_cursor_id FROM halo_sessions",
              )
              .all() as SessionProductFieldsRow[]
          ).map((row) => [row.id, decodeProductFields(row)]),
        ),
    );
  }
  async getProductFields(sessionId: string) {
    return await this.database.access((connection) => {
      const row = connection
        .prepare(
          "SELECT id, marked_done, read_receipt_cursor_id FROM halo_sessions WHERE id = ?",
        )
        .get(sessionId) as SessionProductFieldsRow | undefined;
      return row === undefined ? undefined : decodeProductFields(row);
    });
  }
  async setMarkedDone(input: { sessionId: string; markedDone: boolean }) {
    return await this.database.access((connection) => {
      connection
        .prepare("UPDATE halo_sessions SET marked_done = ? WHERE id = ?")
        .run(input.markedDone ? 1 : 0, input.sessionId);
    });
  }
  async setReadReceipt(input: {
    sessionId: string;
    readReceiptCursorId?: string;
  }) {
    return await this.database.access((connection) => {
      connection
        .prepare(
          "UPDATE halo_sessions SET read_receipt_cursor_id = ? WHERE id = ?",
        )
        .run(input.readReceiptCursorId ?? null, input.sessionId);
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const closed = await Promise.all(
      [...this.storages].map(
        async (storage) =>
          await storage
            .close(BACKGROUND_CONTEXT)
            .catch(
              (cause) =>
                new SessionBackendError({ detail: "Close storage", cause }),
            ),
      ),
    );
    return closed.find((item) => item instanceof Error);
  }

  private async openReserved(
    metadata: SessionMetadata,
  ): Promise<SessionHandle> {
    const opened = await TursoStorage.open({
      database: this.database,
      sessionId: metadata.id,
    }).catch(
      (cause) => new SessionBackendError({ detail: "Open storage", cause }),
    );
    if (opened instanceof Error) {
      this.reserved.delete(metadata.id);
      throw opened;
    }
    const storage = opened;
    storage.setOnClose(() => {
      this.reserved.delete(metadata.id);
      this.storages.delete(storage);
    });
    this.storages.add(storage);
    return {
      metadata,
      storage,
      fatalCommitErrors: storage.fatalCommitErrors,
      read: async () => await storage.read(),
      close: async () => await storage.close(BACKGROUND_CONTEXT),
    };
  }
  private reserve(sessionId: string) {
    this.assertOpen();
    if (this.reserved.has(sessionId))
      throw new SessionBackendError({
        detail: `Session is already open: ${sessionId}`,
      });
    this.reserved.add(sessionId);
  }
  private assertOpen() {
    if (this.closed)
      throw new SessionBackendError({ detail: "Repository is closed" });
  }
}

function decodeProductFields(
  row: SessionProductFieldsRow,
): SessionProductFields {
  const fields: SessionProductFields = { markedDone: row.marked_done === 1 };
  if (row.read_receipt_cursor_id !== null)
    fields.readReceiptCursorId = row.read_receipt_cursor_id;
  return fields;
}
