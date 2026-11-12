/**
 * The open bot, beside the list of every bot on this computer.
 * The transcript is loaded here. A turn that is still running is shown only
 * up to the person's message, and the client resumes the reply from there.
 */
import { BotShell } from "@/components/bot-shell";
import { AppHeader } from "@/components/theme-toggle";
import { openFirstBot } from "@/lib/daemon";
import { connection } from "next/server";

export default async function Home() {
  await connection();
  const opened = await openHome();
  if (!opened.ok) {
    return (
      <div className="flex flex-1 flex-col">
        <AppHeader title="Companion" />
        <main className="flex flex-1 items-center justify-center p-8">
          <p className="max-w-md text-muted-foreground">{opened.message}</p>
        </main>
      </div>
    );
  }
  return <BotShell bots={opened.bots} chat={opened.chat} />;
}

/**
 * The sidebar and the first bot.
 * A failure here is the daemon being unreachable, which the page explains.
 */
async function openHome(): Promise<
  | ({ ok: true } & Awaited<ReturnType<typeof openFirstBot>>)
  | { ok: false; message: string }
> {
  try {
    const opened = await openFirstBot();
    return { ok: true, bots: opened.bots, chat: opened.chat };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "The daemon is not available.",
    };
  }
}
