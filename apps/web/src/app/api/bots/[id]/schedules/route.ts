/**
 * One bot's schedules, for the panel beside the chat.
 * The browser reads them here. It cannot create one.
 */
import { listScheduleViews, ScheduleRequestError } from "@/lib/schedules";
import { refuseUnsigned } from "@/lib/supabase/server";
import { connection } from "next/server";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const denied = await refuseUnsigned();
  if (denied) return denied;
  await connection();
  const { id } = await context.params;
  try {
    return Response.json(await listScheduleViews(id));
  } catch (error) {
    return scheduleFailure(error);
  }
}

function scheduleFailure(error: unknown): Response {
  if (error instanceof ScheduleRequestError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  const message =
    error instanceof Error ? error.message : "The daemon is not available.";
  return Response.json({ error: message }, { status: 502 });
}
