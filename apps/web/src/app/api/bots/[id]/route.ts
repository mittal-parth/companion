/**
 * One bot, as the sidebar uses it.
 * GET is the conversation. PATCH changes the name and leaves the conversation.
 */
import { daemonError, daemonFetch, loadBot } from "@/lib/daemon";
import type { BotView } from "@companion/shared";
import { connection } from "next/server";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  await connection();
  const { id } = await context.params;
  try {
    return Response.json(await loadBot(id));
  } catch (error) {
    return daemonFailure(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  await connection();
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "The request needs a name." },
      { status: 400 },
    );
  }
  const name = textField(body, "name");
  if (name === undefined) {
    return Response.json({ error: "A bot needs a name." }, { status: 400 });
  }
  try {
    const daemon = await daemonFetch(`/bots/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!daemon.ok) {
      return Response.json(
        { error: await daemonError(daemon) },
        { status: daemon.status || 502 },
      );
    }
    const bot = (await daemon.json()) as BotView;
    return Response.json({ id: bot.id, name: bot.name });
  } catch (error) {
    return daemonFailure(error);
  }
}

function textField(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return undefined;
  }
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** A daemon error the page can show. An unknown bot is missing. */
function daemonFailure(error: unknown): Response {
  const message =
    error instanceof Error ? error.message : "The daemon is not available.";
  const status = message.startsWith("Unknown bot") ? 404 : 502;
  return Response.json({ error: message }, { status });
}
