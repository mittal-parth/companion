/**
 * One bot, opened from its address.
 * The id is the one the daemon already stored. A refresh of this address
 * opens the same bot. The home page, /, still opens the first bot.
 */
import { BotScreen, openDaemon } from "@/components/bot-screen";
import { openBot } from "@/lib/daemon";
import { connection } from "next/server";

export default async function BotAddress({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();
  const { id } = await params;
  return <BotScreen opened={await openDaemon(() => openBot(id))} />;
}
