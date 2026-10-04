import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Harness,
  createRegistry,
  defineExtension,
  section,
  type Conversation,
  type ToolRegistration,
  type EntryDraft,
} from "@earendil-works/pi-durable";
import type { SessionHandle, SessionData } from "../storage/SessionRepoApi.js";
import type { LLMApi } from "../llm/LLMApi.js";
import { createPiModelRuntime } from "../llm/createPiModelRuntime.js";
import * as errore from "errore";
import { Stream } from "@get-halo/shared/Stream";
import {
  type HaloMessage as StoredMessage,
  type SessionWatchItem,
  type HaloConnectionEvent,
  type HaloConnectionState,
  type ChatPrompt,
  type SessionSnapshot,
  type SessionSummary,
  chatPromptContent,
} from "@get-halo/client";
import { prepareChatAttachments } from "./chatAttachments.js";
import type { WorkspaceLayout } from "../workspace/WorkspaceService.js";
import type { FilesystemService } from "../filesystem/FilesystemService.js";
import type { ToolRuntime } from "./runtime/ToolRuntime.js";
import { createAuthorizedCodingTools } from "./tools/codingTools.js";
import { createExecTool } from "./tools/execTool.js";
import { limitToolOutput } from "./tools/limitToolOutput.js";
import { WorkspaceResourceLoader } from "./WorkspaceResourceLoader.js";
import type { HaloEnvironment } from "./workspacePrompt.js";
import { sessionEvents } from "./sessionEvents.js";
import {
  HaloSessionDoc,
  SessionProjection,
  type MessagePresentation,
} from "./SessionProjection.js";

export class EmptyPromptError extends errore.createTaggedError({
  name: "EmptyPromptError",
  message: "Enter a prompt first.",
}) {}
export class PromptFailedError extends errore.createTaggedError({
  name: "PromptFailedError",
  message: "$reason",
}) {}
export class AbortFailedError extends errore.createTaggedError({
  name: "AbortFailedError",
  message: "$reason",
}) {}
export class CreateAgentSessionError extends errore.createTaggedError({
  name: "CreateAgentSessionError",
  message: "Failed to create agent session",
}) {}
export class SessionStorageError extends errore.createTaggedError({
  name: "SessionStorageError",
  message: "Could not access storage for session '$sessionId'",
}) {}

type SessionNotification = {
  customType: "halo.integration.connected";
  content: string;
};
export type HaloAgentSessionOptions = {
  environment: HaloEnvironment;
  llmApi: LLMApi;
  filesystem: FilesystemService;
  layout: WorkspaceLayout;
  toolRuntime: ToolRuntime;
};

export class HaloAgentSession {
  // All consumers observe the same complete committed revision.
  private snapshot: SessionSnapshot;
  private readonly projection: SessionProjection;
  private readonly updates = new Stream<SessionWatchItem>();
  private readonly summaryChanges = new Stream<void>();
  private readonly closed = new AbortController();
  private readonly detach: () => void;
  private readonly detachStorage: () => void;
  readonly sessionId: string;
  private readonly harness: Harness;
  private readonly conversation: Conversation;
  private readonly stored: SessionHandle;
  private readonly filesystem: FilesystemService;
  private readonly workspaceRoot: string;

  private constructor(ctx: {
    harness: Harness;
    conversation: Conversation;
    stored: SessionHandle;
    data: SessionData;
    filesystem: FilesystemService;
    workspaceRoot: string;
  }) {
    const { harness, conversation, stored, data, filesystem, workspaceRoot } =
      ctx;
    this.harness = harness;
    this.conversation = conversation;
    this.stored = stored;
    this.sessionId = stored.metadata.id;
    this.filesystem = filesystem;
    this.workspaceRoot = workspaceRoot;
    this.projection = new SessionProjection(data);
    this.snapshot = this.projection.snapshot();
    // Installed while the bootstrap commit still owns the mutation line.
    this.detach = harness.subscribeCommits((publication) => {
      const previous = this.snapshot;
      const summary = this.readSummary();
      this.projection.apply(publication);
      this.snapshot = this.projection.snapshot();
      for (const event of sessionEvents(previous, this.snapshot))
        this.updates.append({ type: "event", event });
      if (JSON.stringify(summary) !== JSON.stringify(this.readSummary()))
        this.summaryChanges.append();
    });
    this.detachStorage = stored.fatalCommitErrors.subscribe((error) => {
      this.snapshot = {
        ...this.snapshot,
        activeRun: undefined,
        fault: error.message,
      };
      this.updates.append({
        type: "event",
        event: { type: "session.failed", error: error.message },
      });
      this.summaryChanges.append();
    });
  }

  static async attach(options: HaloAgentSessionOptions, stored: SessionHandle) {
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => await stored.close());
    const { layout, toolRuntime: runtime, llmApi } = options;
    const runtimeDescription = await runtime.getAgentDescription();
    if (runtimeDescription instanceof Error) return runtimeDescription;
    const resourceLoader = new WorkspaceResourceLoader({
      environment: options.environment,
      workspaceRoot: layout.root,
    });
    const reloaded = await resourceLoader.reload();
    if (reloaded instanceof Error) return reloaded;
    const tools: ToolRegistration[] = [
      ...createAuthorizedCodingTools({
        cwd: layout.root,
        sessionId: stored.metadata.id,
        filesystem: options.filesystem,
        authority: runtime,
      }).map((tool: AgentTool): ToolRegistration => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        replay:
          tool.name === "read" || tool.name === "viewImage" ? "safe" : "unsafe",
        execute: async (params, api, context) => {
          const result = await tool.execute(
            api.callId,
            params,
            context.abortSignal,
          );
          return {
            ...result,
            details: copyJson(result.details, {
              omitUndefinedProperties: true,
            }),
          };
        },
      })),
      createExecTool({ runtime, runtimeDescription, modelId: llmApi.model.id }),
    ].map((tool) =>
      limitToolOutput(tool, {
        workspaceRoot: layout.root,
        sessionId: stored.metadata.id,
      }),
    );
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "halo",
        tools,
        sections: [section("halo", () => resourceLoader.getSystemPrompt())],
      }),
    );
    const harness = await Harness.open(
      stored.storage,
      {
        models: createPiModelRuntime(llmApi),
        registry,
        settings: { toolExecution: "parallel" },
        onReport: (error) => console.warn("Pi Durable", error),
      },
      BACKGROUND_CONTEXT,
    ).catch((cause) => new CreateAgentSessionError({ cause }));
    if (harness instanceof Error) return harness;
    cleanup.defer(async () => await harness.close(BACKGROUND_CONTEXT));
    const conversation = await harness
      .root(BACKGROUND_CONTEXT, {
        init: async (tx, conversationId) => {
          await tx.doc(HaloSessionDoc, conversationId);
        },
      })
      .catch((cause) => new CreateAgentSessionError({ cause }));
    if (conversation instanceof Error) return conversation;
    const configured = await conversation
      .configure(
        {
          model: { provider: llmApi.model.provider, modelId: llmApi.model.id },
          cwd: layout.root,
        },
        BACKGROUND_CONTEXT,
      )
      .catch((cause) => new CreateAgentSessionError({ cause }));
    if (configured instanceof Error) return configured;
    const session = await harness
      .commit(
        async () =>
          new HaloAgentSession({
            harness,
            conversation,
            stored,
            data: await stored.read(),
            filesystem: options.filesystem,
            workspaceRoot: layout.root,
          }),
        BACKGROUND_CONTEXT,
      )
      .catch((cause) => new CreateAgentSessionError({ cause }));
    if (session instanceof Error) return session;
    cleanup.move();
    return session;
  }

  resume() {
    this.harness.resume();
  }

  onSummaryChange(listener: () => Promise<void>) {
    return this.summaryChanges.subscribe(() => {
      queueMicrotask(() => {
        // oxlint-disable-next-line typescript/no-floating-promises -- The registry tracks summary work through shutdown and reports returned errors.
        listener();
      });
    });
  }

  readSnapshot(connections: HaloConnectionState[]) {
    return { ...this.snapshot, connections };
  }

  async *watch(options: {
    signal?: AbortSignal;
    readConnections: () => HaloConnectionState[];
  }): AsyncGenerator<SessionWatchItem> {
    const abortSignal =
      options.signal === undefined
        ? this.closed.signal
        : AbortSignal.any([options.signal, this.closed.signal]);
    using updates = this.updates.consume({ abortSignal });
    if (abortSignal.aborted) return;
    yield {
      type: "snapshot",
      snapshot: this.readSnapshot(options.readConnections()),
    };
    yield* updates;
  }

  publishConnectionEvent(event: HaloConnectionEvent) {
    this.updates.append({ type: "event", event });
  }

  async appendMessages(messages: readonly StoredMessage[]) {
    return await this.conversation
      .commit(async (tx) => {
        for (const message of messages)
          await tx.appendEntry(this.conversation.id, messageDraft(message));
      }, BACKGROUND_CONTEXT)
      .catch(
        (cause) =>
          new SessionStorageError({ sessionId: this.sessionId, cause }),
      );
  }

  async setName(name: string) {
    return await this.conversation
      .commit(async (tx) => {
        (await tx.doc(HaloSessionDoc, this.conversation.id)).name = name;
      }, BACKGROUND_CONTEXT)
      .catch(
        (cause) =>
          new SessionStorageError({ sessionId: this.sessionId, cause }),
      );
  }

  async prompt(input: ChatPrompt) {
    const text = input.text.trim();
    const files = input.files ?? [];
    const references = input.references ?? [];
    if (text.length === 0 && files.length === 0 && references.length === 0)
      return new EmptyPromptError();
    const content = chatPromptContent(text, references);
    if (files.length > 0) {
      const prepared = await prepareChatAttachments({
        files,
        filesystem: this.filesystem,
        workspaceRoot: this.workspaceRoot,
      });
      if (prepared instanceof Error) return prepared;
      return await this.send({
        role: "user",
        content: [{ type: "text", text: content }, ...prepared.content],
        displayText: text,
        attachments: prepared.attachments,
        references,
        clientMessageId: input.clientMessageId,
        timestamp: Date.now(),
      });
    }
    return await this.send({
      role: "user",
      content,
      displayText: text,
      references,
      clientMessageId: input.clientMessageId,
      timestamp: Date.now(),
    });
  }

  private async send(
    message: Extract<StoredMessage, { role: "user" | "custom" }>,
  ) {
    const requestId =
      message.role === "user"
        ? (message.clientMessageId ?? randomUUID())
        : randomUUID();
    const saved = await this.conversation
      .commit(async (tx) => {
        const state = await tx.doc(HaloSessionDoc, this.conversation.id);
        if (message.role === "user") {
          const { content: _content, ...presentation } = message;
          // SAFETY: Removing undefined optional fields preserves the presentation shape and makes it valid Chord JSON.
          state.inputs[requestId] ??= copyJson(presentation, {
            omitUndefinedProperties: true,
          }) as MessagePresentation;
        } else {
          const {
            content: _content,
            details: _details,
            ...presentation
          } = message;
          // SAFETY: Removing undefined optional fields preserves the presentation shape and makes it valid Chord JSON.
          state.inputs[requestId] ??= copyJson(presentation, {
            omitUndefinedProperties: true,
          }) as MessagePresentation;
        }
      }, BACKGROUND_CONTEXT)
      .catch(
        (cause) =>
          new PromptFailedError({ reason: "Could not save message", cause }),
      );
    if (saved instanceof Error) return saved;
    const submitted = await this.conversation
      .submit(
        {
          type: "input",
          content: message.content,
          requestId,
          whenBusy: "steer",
        },
        BACKGROUND_CONTEXT,
      )
      .catch(
        (cause) => new PromptFailedError({ reason: "Prompt failed", cause }),
      );
    if (submitted instanceof Error) return submitted;
    const status = await submitted
      .status(BACKGROUND_CONTEXT)
      .catch(
        (cause) =>
          new PromptFailedError({ reason: "Could not read submission", cause }),
      );
    if (status instanceof Error) return status;
    if (status.status === "queued") return;
    const settled = await submitted
      .wait(BACKGROUND_CONTEXT)
      .catch(
        (cause) =>
          new PromptFailedError({ reason: "Prompt interrupted", cause }),
      );
    if (settled instanceof Error) return settled;
    return {
      status:
        settled.status === "done"
          ? ("completed" as const)
          : settled.reason === "aborted"
            ? ("aborted" as const)
            : ("failed" as const),
      error:
        settled.status === "unanswered"
          ? { message: settled.reason }
          : undefined,
    };
  }

  async abort() {
    return await this.conversation
      .abort(BACKGROUND_CONTEXT)
      .catch(
        (cause) => new AbortFailedError({ reason: "Abort failed", cause }),
      );
  }
  async notify(input: SessionNotification) {
    return await this.send({
      role: "custom",
      ...input,
      display: false,
      timestamp: Date.now(),
    });
  }

  async close() {
    this.closed.abort();
    const closed = await this.harness
      .close(BACKGROUND_CONTEXT)
      .catch(
        (cause) =>
          new AbortFailedError({ reason: "Session close failed", cause }),
      );
    this.detach();
    this.detachStorage();
    if (closed instanceof Error) return closed;
  }

  readSummary(): Omit<SessionSummary, "markedDone" | "readReceiptCursorId"> {
    const snapshot = this.snapshot;
    const latest = snapshot.entries.at(-1);
    const timestamp =
      latest?.type === "message" ? latest.message.timestamp : latest?.timestamp;
    return {
      sessionId: this.sessionId,
      agent: "pi",
      cwd: this.workspaceRoot,
      title: this.projection.title(snapshot).trim() || undefined,
      isRunning: snapshot.activeRun !== undefined,
      latestResultId:
        snapshot.lastRun?.id ??
        snapshot.entries.findLast(
          (entry) =>
            entry.type === "message" && entry.message.role === "assistant",
        )?.id,
      createdAt: new Date(this.stored.metadata.createdAt).toISOString(),
      updatedAt: new Date(
        timestamp ?? this.stored.metadata.createdAt,
      ).toISOString(),
    };
  }
}

function messageDraft(message: StoredMessage): EntryDraft {
  const model: Message[] =
    message.role === "user" || message.role === "assistant"
      ? [message]
      : message.role === "toolResult"
        ? [
            {
              ...message,
              details:
                message.details === undefined
                  ? undefined
                  : copyJson(message.details, {
                      omitUndefinedProperties: true,
                    }),
            },
          ]
        : message.role === "custom"
          ? [
              {
                role: "user",
                content: message.content,
                timestamp: message.timestamp,
              },
            ]
          : [];
  return {
    kind: "halo.message",
    model,
    data: copyJson({ message }, { omitUndefinedProperties: true }),
  };
}
