/**
 * Turns ACP session updates into the messages and stream the chat renders.
 * The daemon keeps the engine's own events. The page speaks the AI SDK's.
 */
import type * as acp from "@agentclientprotocol/sdk";
import type { TurnEvent } from "@companion/shared";
import type {
  DynamicToolUIPart,
  FinishReason,
  UIMessage,
  UIMessageChunk,
} from "ai";

type Piece =
  | { type: "text"; text: string }
  | { type: "file"; mediaType: string; url: string };

type ToolDraft = {
  toolCallId: string;
  name?: string | null;
  title?: string | null;
  status?: acp.ToolCallStatus | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: acp.ToolCallContent[] | null;
};

type Draft = {
  id: string;
  role: "user" | "assistant";
  parts: UIMessage["parts"];
  textKey?: string;
  reasoningKey?: string;
  tools: Map<string, ToolDraft>;
};

/**
 * Builds the chat's message list from a stored transcript.
 * Consecutive user chunks are one message. The reply that follows is the next.
 * A running turn should pass only the updates before its reply, so the resume
 * stream can play that reply once.
 */
export function transcriptToMessages(
  updates: readonly acp.SessionUpdate[],
): UIMessage[] {
  const messages: UIMessage[] = [];
  let current: Draft | undefined;

  const flush = () => {
    if (current === undefined || current.parts.length === 0) {
      current = undefined;
      return;
    }
    messages.push({
      id: current.id,
      role: current.role,
      parts: current.parts,
    });
    current = undefined;
  };

  const ensure = (role: "user" | "assistant", index: number): Draft => {
    if (current !== undefined && current.role !== role) flush();
    if (current === undefined) {
      current = {
        id: `${role}-${index}`,
        role,
        parts: [],
        tools: new Map(),
      };
    }
    return current;
  };

  updates.forEach((update, index) => {
    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        const message = ensure("user", index);
        appendPieces(message, pieces(update.content), "user");
        break;
      }
      case "agent_message_chunk": {
        const message = ensure("assistant", index);
        appendPieces(
          message,
          pieces(update.content),
          update.messageId ?? "text",
        );
        break;
      }
      case "agent_thought_chunk": {
        const message = ensure("assistant", index);
        appendReasoning(message, update.messageId, pieces(update.content));
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const message = ensure("assistant", index);
        message.textKey = undefined;
        message.reasoningKey = undefined;
        upsertTool(message, update);
        break;
      }
      case "notice": {
        const message = ensure("assistant", index);
        appendPieces(
          message,
          [{ type: "text", text: noticeText(update) }],
          "notice",
        );
        break;
      }
      case "plan":
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
      case "usage_update":
      case "compaction_update":
      case "compaction_summary_chunk":
        // Session bookkeeping. The chat shows the conversation, not the engine's internals.
        break;
      default: {
        const unexpected: never = update;
        throw new Error(`Unexpected update ${JSON.stringify(unexpected)}.`);
      }
    }
  });
  flush();
  return messages;
}

/**
 * Converts one turn's daemon events into the chunks of a single assistant message.
 * The person's own message is not in this stream. It is already stored, and the
 * page rendered it before asking for the reply.
 */
export function createReplyStream(): {
  chunks(event: TurnEvent): UIMessageChunk[];
  /** Closes the message when the daemon ended the turn without a final event. */
  finish(): UIMessageChunk[];
  outcome():
    { status: "completed" } | { status: "failed" } | { status: "unknown" };
} {
  let started = false;
  let ended = false;
  let outcome:
    { status: "completed" } | { status: "failed" } | { status: "unknown" } = {
    status: "unknown",
  };
  let open: { kind: "text" | "reasoning"; id: string } | undefined;
  let textCount = 0;
  let reasoningCount = 0;
  const tools = new Map<string, ToolDraft & { announced: boolean }>();

  const closeOpen = (out: UIMessageChunk[]) => {
    if (open?.kind === "text") out.push({ type: "text-end", id: open.id });
    if (open?.kind === "reasoning") {
      out.push({ type: "reasoning-end", id: open.id });
    }
    open = undefined;
  };

  const begin = (out: UIMessageChunk[]) => {
    if (started) return;
    started = true;
    out.push({ type: "start" });
  };

  const partId = (
    kind: "text" | "reasoning",
    messageId: string | null | undefined,
  ): string => {
    if (messageId != null && messageId !== "") return messageId;
    if (open?.kind === kind) return open.id;
    if (kind === "text") {
      textCount += 1;
      return `text-${textCount}`;
    }
    reasoningCount += 1;
    return `reasoning-${reasoningCount}`;
  };

  const textChunks = (
    kind: "text" | "reasoning",
    messageId: string | null | undefined,
    text: string,
  ): UIMessageChunk[] => {
    const out: UIMessageChunk[] = [];
    const id = partId(kind, messageId);
    if (open?.kind !== kind || open.id !== id) {
      closeOpen(out);
      out.push(
        kind === "text"
          ? { type: "text-start", id }
          : { type: "reasoning-start", id },
      );
      open = { kind, id };
    }
    out.push(
      kind === "text"
        ? { type: "text-delta", id, delta: text }
        : { type: "reasoning-delta", id, delta: text },
    );
    return out;
  };

  const contentChunks = (
    kind: "text" | "reasoning",
    messageId: string | null | undefined,
    content: acp.ContentBlock,
  ): UIMessageChunk[] => {
    const out: UIMessageChunk[] = [];
    for (const piece of pieces(content)) {
      if (piece.type === "text") {
        out.push(...textChunks(kind, messageId, piece.text));
        continue;
      }
      closeOpen(out);
      out.push({ type: "file", url: piece.url, mediaType: piece.mediaType });
    }
    return out;
  };

  const toolChunks = (
    update: acp.SessionUpdate & {
      sessionUpdate: "tool_call" | "tool_call_update";
    },
  ): UIMessageChunk[] => {
    const out: UIMessageChunk[] = [];
    closeOpen(out);
    let draft = tools.get(update.toolCallId);
    if (draft === undefined) {
      draft = { toolCallId: update.toolCallId, announced: false };
      tools.set(update.toolCallId, draft);
    }
    applyTool(draft, update);
    const part = toDynamicTool(draft);
    if (part.state === "input-streaming") {
      out.push({
        type: "tool-input-start",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        dynamic: true,
        title: part.title,
      });
      return out;
    }
    if (!draft.announced || part.state === "input-available") {
      out.push({
        type: "tool-input-available",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
        dynamic: true,
        title: part.title,
      });
      draft.announced = true;
    }
    if (part.state === "output-available") {
      out.push({
        type: "tool-output-available",
        toolCallId: part.toolCallId,
        output: part.output,
        dynamic: true,
      });
    }
    if (part.state === "output-error") {
      out.push({
        type: "tool-output-error",
        toolCallId: part.toolCallId,
        errorText: part.errorText,
        dynamic: true,
      });
    }
    return out;
  };

  return {
    chunks(event) {
      if (ended) return [];
      const out: UIMessageChunk[] = [];
      switch (event.event) {
        case "update":
          begin(out);
          out.push(...updateChunks(event.data));
          break;
        case "done":
          begin(out);
          closeOpen(out);
          out.push({
            type: "finish",
            finishReason: finishReason(event.data.stopReason),
          });
          ended = true;
          outcome = { status: "completed" };
          break;
        case "error":
          begin(out);
          closeOpen(out);
          out.push({ type: "error", errorText: event.data.error });
          out.push({ type: "finish", finishReason: "error" });
          ended = true;
          outcome = { status: "failed" };
          break;
        default: {
          const unexpected: never = event;
          throw new Error(`Unexpected event ${JSON.stringify(unexpected)}.`);
        }
      }
      return out;
    },
    finish() {
      if (ended) return [];
      const out: UIMessageChunk[] = [];
      if (started) {
        closeOpen(out);
        out.push({ type: "finish", finishReason: "other" });
      }
      ended = true;
      return out;
    },
    outcome: () => outcome,
  };

  function updateChunks(update: acp.SessionUpdate): UIMessageChunk[] {
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        // Stored before the reply. The page already shows it.
        return [];
      case "agent_message_chunk":
        return contentChunks("text", update.messageId, update.content);
      case "agent_thought_chunk":
        return contentChunks("reasoning", update.messageId, update.content);
      case "tool_call":
      case "tool_call_update":
        return toolChunks(update);
      case "notice":
        return textChunks("text", undefined, noticeText(update));
      case "plan":
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
      case "usage_update":
      case "compaction_update":
      case "compaction_summary_chunk":
        return [];
      default: {
        const unexpected: never = update;
        throw new Error(`Unexpected update ${JSON.stringify(unexpected)}.`);
      }
    }
  }
}

/** One content block as text the chat can show, or a file the chat can render. */
function pieces(block: acp.ContentBlock): Piece[] {
  switch (block.type) {
    case "text":
      return block.text === "" ? [] : [{ type: "text", text: block.text }];
    case "image":
    case "audio":
      return [
        {
          type: "file",
          mediaType: block.mimeType,
          url: `data:${block.mimeType};base64,${block.data}`,
        },
      ];
    case "resource_link":
      return [{ type: "text", text: block.name }];
    case "resource":
      return [
        {
          type: "text",
          text:
            "text" in block.resource ? block.resource.text : block.resource.uri,
        },
      ];
    default: {
      const unexpected: never = block;
      throw new Error(`Unexpected content ${JSON.stringify(unexpected)}.`);
    }
  }
}

function appendPieces(message: Draft, next: Piece[], key: string): void {
  for (const piece of next) {
    if (piece.type === "file") {
      message.textKey = undefined;
      message.reasoningKey = undefined;
      message.parts.push({
        type: "file",
        mediaType: piece.mediaType,
        url: piece.url,
      });
      continue;
    }
    const last = message.parts.at(-1);
    if (last?.type === "text" && message.textKey === key) {
      last.text += piece.text;
      continue;
    }
    message.textKey = key;
    message.reasoningKey = undefined;
    message.parts.push({ type: "text", text: piece.text, state: "done" });
  }
}

function noticeText(
  update: acp.SessionUpdate & { sessionUpdate: "notice" },
): string {
  return update.description == null
    ? update.title
    : `${update.title}. ${update.description}`;
}

function appendReasoning(
  message: Draft,
  messageId: string | null | undefined,
  next: Piece[],
): void {
  const key = messageId ?? "reasoning";
  for (const piece of next) {
    if (piece.type !== "text") continue;
    const last = message.parts.at(-1);
    if (last?.type === "reasoning" && message.reasoningKey === key) {
      last.text += piece.text;
      continue;
    }
    message.reasoningKey = key;
    message.textKey = undefined;
    message.parts.push({
      type: "reasoning",
      id: key,
      text: piece.text,
      state: "done",
    });
  }
}

function upsertTool(
  message: Draft,
  update: acp.SessionUpdate & {
    sessionUpdate: "tool_call" | "tool_call_update";
  },
): void {
  let draft = message.tools.get(update.toolCallId);
  if (draft === undefined) {
    draft = { toolCallId: update.toolCallId };
    message.tools.set(update.toolCallId, draft);
  }
  applyTool(draft, update);
  const part = toDynamicTool(draft);
  const index = message.parts.findIndex(
    (item) =>
      item.type === "dynamic-tool" && item.toolCallId === update.toolCallId,
  );
  if (index === -1) message.parts.push(part);
  else message.parts[index] = part;
}

function applyTool(
  draft: ToolDraft,
  update: acp.SessionUpdate & {
    sessionUpdate: "tool_call" | "tool_call_update";
  },
): void {
  if (update.sessionUpdate === "tool_call") {
    draft.title = update.title;
    draft.name = update.name;
    draft.status = update.status;
    draft.rawInput = update.rawInput;
    draft.rawOutput = update.rawOutput;
    draft.content = update.content;
    return;
  }
  // A null field means "leave the previous value", the same as omitting it.
  if (update.title != null) draft.title = update.title;
  if (update.name != null) draft.name = update.name;
  if (update.status != null) draft.status = update.status;
  if (update.rawInput !== undefined) draft.rawInput = update.rawInput;
  if (update.rawOutput !== undefined) draft.rawOutput = update.rawOutput;
  if (update.content != null) draft.content = update.content;
}

/** The tool call as a dynamic tool part, which is how an unknown tool is shown. */
function toDynamicTool(draft: ToolDraft): DynamicToolUIPart {
  const toolName = draft.name || draft.title || "tool";
  const title = draft.title ?? undefined;
  const status = draft.status ?? "pending";
  const base = {
    type: "dynamic-tool" as const,
    toolName,
    toolCallId: draft.toolCallId,
    title,
  };
  switch (status) {
    case "pending":
    case "in_progress":
      if (draft.rawInput === undefined) {
        return { ...base, state: "input-streaming" };
      }
      return { ...base, state: "input-available", input: draft.rawInput };
    case "completed":
      return {
        ...base,
        state: "output-available",
        input: draft.rawInput ?? {},
        output: toolOutput(draft),
      };
    case "failed":
      return {
        ...base,
        state: "output-error",
        input: draft.rawInput,
        errorText: toolError(draft),
      };
    default: {
      const unexpected: never = status;
      throw new Error(`Unexpected tool status ${String(unexpected)}.`);
    }
  }
}

function toolOutput(draft: ToolDraft): unknown {
  const text = toolContentText(draft.content);
  if (text !== undefined) return text;
  return draft.rawOutput ?? null;
}

function toolError(draft: ToolDraft): string {
  const raw = draft.rawOutput;
  if (typeof raw === "object" && raw !== null && "error" in raw) {
    const error = (raw as { error?: unknown }).error;
    if (typeof error === "string" && error !== "") return error;
  }
  return toolContentText(draft.content) ?? "The tool failed.";
}

function toolContentText(
  content: acp.ToolCallContent[] | null | undefined,
): string | undefined {
  if (content == null || content.length === 0) return undefined;
  const text = content
    .map((item) => {
      switch (item.type) {
        case "content":
          return pieces(item.content)
            .map((piece) => (piece.type === "text" ? piece.text : piece.url))
            .join("");
        case "diff":
          return item.newText;
        case "terminal":
          return item.terminalId;
        default: {
          const unexpected: never = item;
          throw new Error(
            `Unexpected tool content ${JSON.stringify(unexpected)}.`,
          );
        }
      }
    })
    .filter((item) => item !== "")
    .join("\n");
  return text === "" ? undefined : text;
}

function finishReason(stop: acp.StopReason): FinishReason {
  switch (stop) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content-filter";
    case "cancelled":
      return "interrupted";
    case "max_turn_requests":
      return "other";
    default: {
      const unexpected: never = stop;
      throw new Error(`Unexpected stop reason ${String(unexpected)}.`);
    }
  }
}
