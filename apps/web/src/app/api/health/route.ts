/**
 * Liveness of the web process for a signed-in account.
 * A caller with no session is refused. The smoke test checks that refusal.
 */
import { refuseUnsigned } from "@/lib/supabase/server";

export async function GET() {
  const denied = await refuseUnsigned();
  if (denied) return denied;
  return Response.json({ ok: true });
}
