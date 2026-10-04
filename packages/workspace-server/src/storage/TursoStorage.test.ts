import fs from "node:fs/promises";
import path from "node:path";
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- Tests construct valid branded durable IDs explicitly.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  StorageRejected,
  type ConversationId,
  type DocumentId,
} from "@earendil-works/pi-durable";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { FilesystemService } from "../filesystem/FilesystemService.js";
import { DatabaseClient } from "./DatabaseClient.js";
import { piBackendTest } from "./fixtures.test.js";
import { TursoSessionRepo } from "./TursoSessionRepo.js";

registerStorageConformance(
  { describe, expect, it },
  "TursoStorage",
  async (use) => {
    const parent = path.resolve(
      import.meta.dirname,
      "../../../../tmp/piBackend",
    );
    await fs.mkdir(parent, { recursive: true });
    const directory = await fs.mkdtemp(path.join(parent, "conformance-"));
    const filesystem = new FilesystemService();
    const database = await DatabaseClient.open({ directory, filesystem });
    if (database instanceof Error) throw database;
    const repo = new TursoSessionRepo(database);
    const handle = await repo.create();

    await use(handle.storage);

    const repoClosed = await repo.close();
    const databaseClosed = await database.close();
    const filesystemClosed = await filesystem.close();
    await fs.rm(directory, { recursive: true, force: true });
    if (repoClosed instanceof Error) throw repoClosed;
    if (databaseClosed instanceof Error) throw databaseClosed;
    if (filesystemClosed instanceof Error) throw filesystemClosed;
  },
);

piBackendTest(
  "reports fatal commit failures through the session handle and preserves the rejection",
  async ({ piBackend }) => {
    const handle = await piBackend.repo.create();
    const fatalErrors: Error[] = [];
    const unsubscribe = handle.fatalCommitErrors.subscribe((error) =>
      fatalErrors.push(error),
    );
    const conversationId = 1 as ConversationId;
    await handle.storage.commit(
      [{ type: "conversation", value: { id: conversationId } }],
      BACKGROUND_CONTEXT,
    );

    const transactionFailure = await handle.storage
      .commit(
        [{ type: "conversation", value: { id: conversationId } }],
        BACKGROUND_CONTEXT,
      )
      .catch((error: Error) => error);
    expect(transactionFailure).toBe(fatalErrors[0]);

    const documentId = 2 as DocumentId;
    const synchronousFailure = await handle.storage
      .commit(
        [
          {
            type: "document.create",
            record: {
              id: documentId,
              kind: "duplicate",
              scope: { kind: "session" },
            },
            content: { kind: "base", version: 1, value: {} },
          },
          {
            type: "document.create",
            record: {
              id: documentId,
              kind: "duplicate",
              scope: { kind: "session" },
            },
            content: { kind: "base", version: 1, value: {} },
          },
        ],
        BACKGROUND_CONTEXT,
      )
      .catch((error: Error) => error);
    expect(synchronousFailure).toBe(fatalErrors[1]);
    expect(fatalErrors).toHaveLength(2);
    unsubscribe();
  },
);

piBackendTest(
  "does not report rejected commits as fatal",
  async ({ piBackend }) => {
    const handle = await piBackend.repo.create();
    const fatalErrors: Error[] = [];
    const unsubscribe = handle.fatalCommitErrors.subscribe((error) =>
      fatalErrors.push(error),
    );
    const sourceId = 2 as DocumentId;
    const copyId = 3 as DocumentId;

    const rejected = await handle.storage
      .commit(
        [
          {
            type: "document.create",
            record: {
              id: sourceId,
              kind: "copy",
              scope: { kind: "session" },
            },
            content: { kind: "base", version: 1, value: {} },
          },
          {
            type: "document.copy",
            record: {
              id: copyId,
              kind: "copy",
              scope: { kind: "session" },
            },
            source: { id: sourceId, at: "current" },
          },
        ],
        BACKGROUND_CONTEXT,
      )
      .catch((error: Error) => error);

    expect(rejected).toBeInstanceOf(StorageRejected);
    expect(fatalErrors).toEqual([]);
    unsubscribe();
  },
);
