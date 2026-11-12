/**
 * The open bot, or a short explanation when that bot cannot be opened.
 * Home and /bots/<id> both use this, so a failure looks the same.
 */
import { BotShell } from "@/components/bot-shell";
import { AppHeader } from "@/components/theme-toggle";
import type { BotSummary, LoadedBot } from "@/lib/daemon";

export function BotScreen({
  opened,
}: {
  opened:
    | { ok: true; bots: BotSummary[]; chat: LoadedBot | null }
    | { ok: false; message: string };
}) {
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
 * Loads the sidebar and the bot the page should show.
 * A failure here is the daemon being unreachable, or an address whose bot
 * is gone, which the page explains.
 */
export async function openDaemon(
  load: () => Promise<{ bots: BotSummary[]; chat: LoadedBot | null }>,
): Promise<
  | { ok: true; bots: BotSummary[]; chat: LoadedBot | null }
  | { ok: false; message: string }
> {
  try {
    const opened = await load();
    return { ok: true, bots: opened.bots, chat: opened.chat };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "The daemon is not available.",
    };
  }
}
