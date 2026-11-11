/**
 * Rejoins a turn the page loaded while it was still running.
 * The daemon replays the reply from `from`, then follows it live.
 * With nothing to replay and no turn running, the answer is 204.
 */
import { connection } from "next/server";
import { chatResponse, daemonFetch } from "@/lib/daemon";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  await connection();
  const { id } = await context.params;
  const from = new URL(request.url).searchParams.get("from");
  const query = from == null ? "" : `?from=${encodeURIComponent(from)}`;
  const daemon = await daemonFetch(
    `/bots/${encodeURIComponent(id)}/events${query}`,
  );
  if (daemon.status === 204) {
    return new Response(null, { status: 204 });
  }
  if (!daemon.ok || daemon.body == null) {
    const body: unknown = await daemon.json().catch(() => undefined);
    const error =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : "The daemon failed.";
    return Response.json({ error }, { status: daemon.status || 502 });
  }
  return chatResponse(daemon.body);
}
