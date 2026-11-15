/**
 * One bot, opened from its address.
 * The id is the one the daemon already stored. A refresh of this address
 * opens the same bot. The home page, /, still opens the first bot.
 */
import { BotScreen, openDaemon } from "@/components/bot-screen";
import { VmSetup } from "@/components/vm-setup";
import { openBot } from "@/lib/daemon";
import { currentAccount } from "@/lib/supabase/server";
import { ensureVm, provisioningEnabled } from "@/lib/vm-aws";
import { connection } from "next/server";
import { redirect } from "next/navigation";

export default async function BotAddress({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();
  const account = await currentAccount();
  if (account === null) redirect("/");
  if (provisioningEnabled()) {
    const vm = await ensureVm(account.id);
    if (vm.status !== "ready") {
      return <VmSetup avatarUrl={account.avatarUrl} initial={vm.status} />;
    }
  }
  const { id } = await params;
  return (
    <BotScreen
      avatarUrl={account.avatarUrl}
      opened={await openDaemon(() => openBot(id))}
    />
  );
}
