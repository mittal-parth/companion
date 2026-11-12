/**
 * Forwards Allow or Deny for a tool call the bot is waiting on.
 * The daemon holds the engine until this answer arrives. Deny stops the call.
 */
import { refuseUnsigned } from "@/lib/supabase/server";
import { connection } from "next/server";
import { daemonError, daemonFetch } from "@/lib/daemon";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const denied = await refuseUnsigned();
  if (denied) return denied;
  await connection();
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "An approval needs a tool call." },
      { status: 400 },
    );
  }
  const daemon = await daemonFetch(
    `/bots/${encodeURIComponent(id)}/approvals`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!daemon.ok) {
    return Response.json(
      { error: await daemonError(daemon) },
      { status: daemon.status || 502 },
    );
  }
  return Response.json(await daemon.json());
}
