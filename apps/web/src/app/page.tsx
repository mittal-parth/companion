/**
 * The open bot, beside the list of every bot on this computer.
 * The home address stays /. It opens the first bot. A chosen bot lives at
 * /bots/<id>, and a refresh of that address opens the same bot.
 */
import { BotScreen, openDaemon } from "@/components/bot-screen";
import { openFirstBot } from "@/lib/daemon";
import { connection } from "next/server";

export default async function Home() {
  await connection();
  return <BotScreen opened={await openDaemon(openFirstBot)} />;
}
