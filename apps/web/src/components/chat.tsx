"use client";

/**
 * One bot's conversation.
 * The shell decides which bot this is. A turn that was already running is
 * resumed from the daemon, which replays the reply, so a reload does not
 * show it twice. While a reply is still being written, a status row sits
 * under the bot's latest message: its picture, three dots, and a rotating line.
 */
import { BotAvatar } from "@/components/bot-avatar";
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
import { lastChatLine } from "@/lib/converter";
import {
  nextLook,
  turnLookIntervalMs,
  turnStatusIntervalMs,
  turnStatusLine,
} from "@/lib/turn-status";
import { useChat } from "@ai-sdk/react";
import type { BotAvatar as ChosenAvatar } from "@companion/shared/avatar";
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
  avatar,
  messages: initialMessages,
  resume,
  replyFrom,
  failure,
  locked = false,
  onPreview,
}: {
  botId: string;
  name: string;
  avatar: ChosenAvatar;
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
          {busy ? <TurnStatus avatar={avatar} /> : null}
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

/**
 * The pieces of one turn.
 * Words and pictures share a bubble. A thought stays beside that bubble.
 * A tool call is not shown: the thread is the text OpenCode sent, not each update.
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
    if (part.type === "dynamic-tool") return;
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
  });
  flushBubble();
  return rendered;
}

/**
 * Sits under the bot's latest message while that turn is still being written.
 * The picture is this bot's avatar, glancing a little at random. The line is
 * one of a short list, not the name of a tool. Words that arrive stay above.
 */
function TurnStatus({ avatar }: { avatar: ChosenAvatar }) {
  const [lineIndex, setLineIndex] = useState(0);
  const [look, setLook] = useState(() => nextLook());

  useEffect(() => {
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const lineTimer = window.setInterval(() => {
      setLineIndex((index) => index + 1);
    }, turnStatusIntervalMs);
    if (reduce) return () => window.clearInterval(lineTimer);
    const lookTimer = window.setInterval(() => {
      setLook((current) => nextLook(current));
    }, turnLookIntervalMs);
    return () => {
      window.clearInterval(lineTimer);
      window.clearInterval(lookTimer);
    };
  }, []);

  const line = turnStatusLine(lineIndex);

  return (
    <div
      aria-live="polite"
      className="flex items-center gap-2.5 text-muted-foreground text-sm"
      data-look={`${look.x.toFixed(2)},${look.y.toFixed(2)}`}
      data-status-line={line}
      data-turn-status=""
      role="status"
    >
      <BotAvatar
        avatar={avatar}
        followPointer={false}
        lookAt={look}
        mood="thinking"
        size={36}
      />
      <span aria-hidden="true" className="inline-flex items-end gap-1">
        {[0, 160, 320].map((delay) => (
          <span
            className="turn-status-dot"
            data-turn-dot=""
            key={delay}
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
      <span className="turn-status-line" key={line}>
        {line}
      </span>
    </div>
  );
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
