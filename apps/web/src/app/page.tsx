/**
 * The open bot, beside the list of every bot on this computer.
 * The home address stays /. It opens the first bot once someone is signed in.
 * A chosen bot lives at /bots/<id>, and a refresh of that address opens the
 * same bot. Nobody signed in sees the sign-in page instead of the app.
 */
import { BotScreen, openDaemon } from "@/components/bot-screen";
import { Landing } from "@/components/landing";
import { openFirstBot } from "@/lib/daemon";
import { currentAccount } from "@/lib/supabase/server";
import { connection } from "next/server";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await connection();
  const account = await currentAccount();
  if (account === null) {
    const { error } = await searchParams;
    return (
      <Landing
        notice={signInNotice(error)}
        passwordForm={process.env.NODE_ENV === "development"}
      />
    );
  }
  return (
    <BotScreen
      avatarUrl={account.avatarUrl}
      opened={await openDaemon(openFirstBot)}
    />
  );
}

function signInNotice(error: string | undefined): string | null {
  if (error === "google") return "Google sign-in did not finish.";
  if (error === "config") return "Sign-in is not configured.";
  return null;
}
