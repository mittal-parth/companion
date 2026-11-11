/**
 * Sends the person's latest message to their bot and streams the reply.
 * File parts become the images the daemon already knows how to store.
 */
import { connection } from "next/server";
import {
  chatResponse,
  daemonError,
  daemonFetch,
  messageForDaemon,
} from "@/lib/daemon";
import type { UIMessage } from "ai";

export async function POST(request: Request) {
  await connection();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "The request needs a message." },
      { status: 400 },
    );
  }
  const id = field(body, "id");
  const message = messageField(body);
  if (id === undefined || message === undefined) {
    return Response.json(
      { error: "The request needs a bot and a user message." },
      { status: 400 },
    );
  }
  let text: string;
  let images: ReturnType<typeof messageForDaemon>["images"];
  try {
    ({ text, images } = messageForDaemon(message));
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "The message is not valid.";
    return Response.json({ error: reason }, { status: 400 });
  }
  const daemon = await daemonFetch(`/bots/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, images }),
  });
  if (!daemon.ok || daemon.body == null) {
    return Response.json(
      { error: await daemonError(daemon) },
      { status: daemon.status || 502 },
    );
  }
  return chatResponse(daemon.body);
}

function field(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return undefined;
  }
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function messageField(body: unknown): UIMessage | undefined {
  if (typeof body !== "object" || body === null || !("message" in body)) {
    return undefined;
  }
  const message = (body as { message?: unknown }).message;
  if (
    typeof message !== "object" ||
    message === null ||
    !("role" in message) ||
    message.role !== "user" ||
    !("parts" in message) ||
    !Array.isArray(message.parts)
  ) {
    return undefined;
  }
  return message as UIMessage;
}
