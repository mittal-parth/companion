/**
 * One bot, as the sidebar uses it.
 * GET is the conversation. PATCH changes the name or the preset picture
 * and leaves the conversation. DELETE removes the bot and its conversation.
 */
import { daemonError, daemonFetch, loadBot } from "@/lib/daemon";
import { parseAvatar } from "@companion/shared/avatar";
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
  const patch = patchFields(body);
  if (!patch.ok) {
    return Response.json({ error: patch.error }, { status: 400 });
  }
  try {
    const daemon = await daemonFetch(`/bots/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch.fields),
    });
    if (!daemon.ok) {
      return Response.json(
        { error: await daemonError(daemon) },
        { status: daemon.status || 502 },
      );
    }
    const bot = (await daemon.json()) as BotView;
    return Response.json({
      id: bot.id,
      name: bot.name,
      avatar: bot.avatar,
    });
  } catch (error) {
    return daemonFailure(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  await connection();
  const { id } = await context.params;
  try {
    const daemon = await daemonFetch(`/bots/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!daemon.ok) {
      return Response.json(
        { error: await daemonError(daemon) },
        { status: daemon.status || 502 },
      );
    }
    return Response.json(await daemon.json());
  } catch (error) {
    return daemonFailure(error);
  }
}

/**
 * A name, a preset picture, or both.
 * A blank name is refused even when a picture is sent with it.
 */
function patchFields(
  body: unknown,
):
  | { ok: true; fields: { name?: string; shape?: string; color?: string } }
  | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "The request needs a name or an avatar." };
  }
  const record = body as Record<string, unknown>;
  if ("name" in record && textField(record, "name") === undefined) {
    return { ok: false, error: "A bot needs a name." };
  }
  const name = textField(record, "name");
  const shape = textField(record, "shape");
  const color = textField(record, "color");
  const sentAvatar = "shape" in record || "color" in record;
  if (
    sentAvatar &&
    (shape === undefined ||
      color === undefined ||
      parseAvatar(shape, color) === undefined)
  ) {
    return { ok: false, error: "An avatar needs a preset shape and color." };
  }
  if (name === undefined && shape === undefined) {
    return { ok: false, error: "The request needs a name or an avatar." };
  }
  return {
    ok: true,
    fields: {
      ...(name === undefined ? {} : { name }),
      ...(shape === undefined || color === undefined ? {} : { shape, color }),
    },
  };
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
