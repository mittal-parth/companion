/**
 * The chat for this computer's default bot.
 * The transcript is loaded here. A turn that is still running is shown only
 * up to the person's message, and the client resumes the reply from there.
 */
import { Chat } from "@/components/chat";
import { ensureDefaultBot } from "@/lib/daemon";
import { transcriptToMessages } from "@/lib/messages";
import type { UIMessage } from "ai";
import { connection } from "next/server";

export default async function Home() {
  await connection();
  const chat = await loadChat();
  if (!chat.ok) {
    return (
      <main className="flex flex-1 items-center justify-center p-8">
        <div className="flex max-w-md flex-col gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">Companion</h1>
          <p className="text-muted-foreground">{chat.message}</p>
        </div>
      </main>
    );
  }
  return (
    <Chat
      botId={chat.botId}
      failure={chat.failure}
      messages={chat.messages}
      replyFrom={chat.replyFrom}
      resume={chat.resume}
    />
  );
}

/**
 * The default bot and the part of its transcript the page should show.
 * A failure here is the daemon being unreachable, which the page explains.
 */
async function loadChat(): Promise<
  | {
      ok: true;
      botId: string;
      messages: UIMessage[];
      resume: boolean;
      replyFrom?: number;
      failure?: string;
    }
  | { ok: false; message: string }
> {
  try {
    const bot = await ensureDefaultBot();
    const turn = bot.turn;
    const running = turn.status === "running";
    return {
      ok: true,
      botId: bot.id,
      messages: transcriptToMessages(
        running ? bot.updates.slice(0, turn.replyFrom) : bot.updates,
      ),
      resume: running,
      replyFrom: running ? turn.replyFrom : undefined,
      failure: turn.status === "failed" ? turn.error : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "The daemon is not available.",
    };
  }
}
