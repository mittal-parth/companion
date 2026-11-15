/**
 * The signed-in user's cloud computer, for the setup screen.
 * GET moves it one step forward (starting it on the first visit) and says
 * where it is. POST is Try again, for a computer whose setup failed.
 */
import { currentAccount, refuseUnsigned } from "@/lib/supabase/server";
import { ensureVm, provisioningEnabled, retryVm } from "@/lib/vm-aws";

async function step(retry: boolean) {
  const denied = await refuseUnsigned();
  if (denied) return denied;
  const account = await currentAccount();
  // Without a relay there is no computer to set up: the daemon is already here.
  if (account === null || !provisioningEnabled()) {
    return Response.json({ status: "ready" });
  }
  try {
    return Response.json(
      retry ? await retryVm(account.id) : await ensureVm(account.id),
    );
  } catch (error) {
    console.error("could not check the user's VM", error);
    return Response.json(
      { error: "Setting up your computer hit a snag." },
      { status: 502 },
    );
  }
}

export const GET = () => step(false);
export const POST = () => step(true);
