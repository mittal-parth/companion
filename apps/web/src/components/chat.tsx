"use client";

/**
 * One bot's conversation.
 * The shell decides which bot this is. A turn that was already running is
 * resumed from the daemon, which replays the reply, so a reload does not
 * show it twice.
 */
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { lastChatLine } from "@/lib/converter";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { useChat } from "@ai-sdk/react";
import {
  imageMimeTypes,
  maxImageBytes,
  maxImagesPerMessage,
} from "@companion/shared/protocol";
import { DefaultChatTransport, type UIMessage } from "ai";
import { PaperclipIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

/** The same image limits the daemon stores, offered by the file picker. */
const imageAccept = imageMimeTypes.join(",");

export function Chat({
  botId,
  name,
  messages: initialMessages,
  resume,
  replyFrom,
  failure,
  locked = false,
  onPreview,
}: {
  botId: string;
  name: string;
  messages: UIMessage[];
  resume: boolean;
  replyFrom?: number;
  failure?: string;
  /** True while another bot is being opened, so a message cannot go to this one. */
  locked?: boolean;
  /** The latest line of this chat, for the row under the bot's name. */
  onPreview: (botId: string, preview: string) => void;
}) {
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        prepareSendMessagesRequest: ({ id, messages }) => ({
          body: { id, message: messages.at(-1) },
        }),
        prepareReconnectToStreamRequest: ({ id }) => ({
          api:
            replyFrom === undefined
              ? `/api/chat/${encodeURIComponent(id)}/stream`
              : `/api/chat/${encodeURIComponent(id)}/stream?from=${replyFrom}`,
        }),
      }),
    [replyFrom],
  );
  const { messages, sendMessage, status, error } = useChat({
    id: botId,
    messages: initialMessages,
    resume,
    transport,
  });
  const [formError, setFormError] = useState<string>();
  useEffect(() => {
    onPreview(botId, lastChatLine(messages));
  }, [botId, messages, onPreview]);
  const busy = status === "submitted" || status === "streaming";
  const held = busy || locked;
  const alert = formError ?? error?.message ?? failure;

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
      <Conversation>
        <ConversationContent>
          {messages.length === 0 ? (
            <ConversationEmptyState
              description="Send a message to start."
              title={name}
            />
          ) : (
            messages.map((message, index) => (
              <Message from={message.role} key={message.id}>
                <MessageParts
                  message={message}
                  streaming={
                    busy &&
                    message.role === "assistant" &&
                    index === messages.length - 1
                  }
                />
              </Message>
            ))
          )}
          {busy && waiting(messages) ? <Shimmer>Replying</Shimmer> : null}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      {alert ? (
        <p className="px-4 pb-2 text-destructive text-sm" role="alert">
          {alert}
        </p>
      ) : null}
      <div className="px-4 pb-4">
        <PromptInput
          accept={imageAccept}
          maxFileSize={maxImageBytes}
          maxFiles={maxImagesPerMessage}
          multiple
          onError={(reason) => setFormError(reason.message)}
          onSubmit={(message) => {
            setFormError(undefined);
            if (held) return;
            void send(message);
          }}
        >
          <Attachments />
          <PromptInputBody>
            <PromptInputTextarea
              aria-label="Message"
              disabled={held}
              placeholder={`Message ${name}`}
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <AttachButton disabled={held} />
            </PromptInputTools>
            <PromptInputSubmit disabled={held} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );

  async function send(message: PromptInputMessage) {
    const text = message.text.trim();
    if (text === "" && message.files.length === 0) return;
    if (text === "") {
      setFormError("A message needs text.");
      return;
    }
    await sendMessage({ files: message.files, text });
  }
}

function waiting(messages: UIMessage[]): boolean {
  const last = messages.at(-1);
  if (last === undefined || last.role === "user") return true;
  return !last.parts.some(
    (part) =>
      (part.type === "text" && part.text !== "") ||
      part.type === "reasoning" ||
      part.type === "dynamic-tool",
  );
}

/**
 * The pieces of one turn.
 * Words and pictures share a bubble. A tool call or a thought stays beside
 * that bubble, so the bubble itself is only what was said.
 */
function MessageParts({
  message,
  streaming,
}: {
  message: UIMessage;
  streaming: boolean;
}) {
  const rendered: ReactNode[] = [];
  let bubble: ReactNode[] = [];
  let bubbleKey = 0;

  const flushBubble = () => {
    if (bubble.length === 0) return;
    const words = bubble;
    bubble = [];
    rendered.push(
      <MessageContent key={`bubble-${bubbleKey}`}>{words}</MessageContent>,
    );
    bubbleKey += 1;
  };

  message.parts.forEach((part, index) => {
    if (part.type === "text") {
      if (part.text === "") return;
      if (message.role === "user") {
        bubble.push(<p key={index}>{part.text}</p>);
        return;
      }
      bubble.push(
        <MessageResponse
          isAnimating={streaming && part.state === "streaming"}
          key={index}
        >
          {part.text}
        </MessageResponse>,
      );
      return;
    }
    if (part.type === "file" && part.mediaType.startsWith("image")) {
      bubble.push(
        // eslint-disable-next-line @next/next/no-img-element -- a data URL of the person's image
        <img
          alt="Attached image"
          className="max-h-48 rounded-md"
          key={index}
          src={part.url}
        />,
      );
      return;
    }
    flushBubble();
    if (part.type === "reasoning") {
      rendered.push(
        <Reasoning
          isStreaming={streaming && part.state === "streaming"}
          key={part.id ?? index}
        >
          <ReasoningTrigger />
          <ReasoningContent>{part.text}</ReasoningContent>
        </Reasoning>,
      );
      return;
    }
    if (part.type === "dynamic-tool") {
      rendered.push(
        <Tool defaultOpen key={part.toolCallId}>
          <ToolHeader
            state={part.state}
            title={part.title}
            toolName={part.toolName}
            type="dynamic-tool"
          />
          <ToolContent>
            <ToolInput input={part.input} />
            <ToolOutput
              errorText={part.errorText}
              output={
                part.state === "output-available" ? part.output : undefined
              }
            />
          </ToolContent>
        </Tool>,
      );
    }
  });
  flushBubble();
  return rendered;
}

function Attachments() {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) return null;
  return (
    <PromptInputHeader>
      {attachments.files.map((file) => (
        <div className="relative" key={file.id}>
          {file.mediaType.startsWith("image") ? (
            // eslint-disable-next-line @next/next/no-img-element -- local preview, not sent yet
            <img
              alt={file.filename ?? "Attached image"}
              className="size-16 rounded-md object-cover"
              src={file.url}
            />
          ) : null}
          <button
            aria-label="Remove image"
            className="absolute -top-1 -right-1 rounded-full bg-background p-0.5"
            onClick={() => attachments.remove(file.id)}
            type="button"
          >
            <XIcon className="size-3" />
          </button>
        </div>
      ))}
    </PromptInputHeader>
  );
}

function AttachButton({ disabled }: { disabled: boolean }) {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputButton
      aria-label="Attach an image"
      disabled={disabled}
      onClick={() => attachments.openFileDialog()}
      tooltip="Attach an image"
    >
      <PaperclipIcon className="size-4" />
    </PromptInputButton>
  );
}
