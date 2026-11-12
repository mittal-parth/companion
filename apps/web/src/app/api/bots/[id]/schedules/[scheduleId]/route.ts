/**
 * Turns one of the open bot's schedules on or off.
 * The time and the prompt stay as the bot stored them.
 */
import { ScheduleRequestError, setScheduleEnabled } from "@/lib/schedules";
import { refuseUnsigned } from "@/lib/supabase/server";
import { connection } from "next/server";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; scheduleId: string }> },
) {
  const denied = await refuseUnsigned();
  if (denied) return denied;
  await connection();
  const { id, scheduleId } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "A schedule needs enabled true or false." },
      { status: 400 },
    );
  }
  const enabled = enabledField(body);
  if (enabled === undefined) {
    return Response.json(
      { error: "A schedule needs enabled true or false." },
      { status: 400 },
    );
  }
  try {
    return Response.json(await setScheduleEnabled(id, scheduleId, enabled));
  } catch (error) {
    if (error instanceof ScheduleRequestError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    const message =
      error instanceof Error ? error.message : "The daemon is not available.";
    return Response.json({ error: message }, { status: 502 });
  }
}

function enabledField(body: unknown): boolean | undefined {
  if (typeof body !== "object" || body === null || !("enabled" in body)) {
    return undefined;
  }
  const value = (body as { enabled?: unknown }).enabled;
  return typeof value === "boolean" ? value : undefined;
}
