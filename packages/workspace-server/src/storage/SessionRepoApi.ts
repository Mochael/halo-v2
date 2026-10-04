import type {
  EntryRecord,
  JsonObject,
  Storage,
  SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { ReadonlyStream } from "@get-halo/shared/Stream";
import type { DatabaseError } from "./DatabaseError.js";

export type SessionMetadata = { id: string; createdAt: number };
export type SessionData = {
  readonly seq: number;
  readonly entries: readonly EntryRecord[];
  readonly submissions: readonly SubmissionRecord[];
  readonly documents: Readonly<Record<string, JsonObject>>;
  readonly lastRun?: SubmissionRecord;
};
export type SessionHandle = {
  metadata: SessionMetadata;
  storage: Storage;
  fatalCommitErrors: ReadonlyStream<Error>;
  read(): Promise<SessionData>;
  close(): Promise<void>;
};

export type SessionProductFields = {
  markedDone: boolean;
  readReceiptCursorId?: string;
};

export interface SessionRepoApi {
  create(options?: { id?: string }): Promise<SessionHandle>;
  open(metadata: SessionMetadata): Promise<SessionHandle>;
  read(sessionId: string): Promise<SessionData>;
  list(): Promise<readonly SessionMetadata[]>;
  close(): Promise<void | Error>;
  listProductFields(): Promise<
    ReadonlyMap<string, SessionProductFields> | DatabaseError
  >;
  getProductFields(
    sessionId: string,
  ): Promise<SessionProductFields | undefined | DatabaseError>;
  setMarkedDone(input: {
    sessionId: string;
    markedDone: boolean;
  }): Promise<void | DatabaseError>;
  setReadReceipt(input: {
    sessionId: string;
    readReceiptCursorId?: string;
  }): Promise<void | DatabaseError>;
}
