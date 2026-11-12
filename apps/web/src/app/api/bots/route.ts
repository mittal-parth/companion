/**
 * Creates a bot and waits until its opening turn is stored.
 * The reply is that bot's conversation, so the page can show the greeting.
 */
import { daemonError, daemonFetch, loadBot } from "@/lib/daemon";
import type { BotView } from "@companion/shared";
import { connection } from "next/server";

export async function POST(request: Request) {
  await connection();
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
    const daemon = await daemonFetch("/bots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!daemon.ok) {
      return Response.json(
        { error: await daemonError(daemon) },
        { status: daemon.status || 502 },
      );
    }
    const created = (await daemon.json()) as BotView;
    return Response.json(await loadBot(created.id), { status: 201 });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The daemon is not available.",
      },
      { status: 502 },
    );
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
