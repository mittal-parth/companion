/**
 * Drives one full turn through the local API with OpenCode on Sarvam GLM 5.3.
 * Skipped unless COMPANION_LIVE=1, so CI does not call the provider.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { BotTranscript, BotView } from "@companion/shared";
import { expect, test } from "vitest";
import { hasToolCall, replyText } from "./acp-hello.js";
import { startDaemon } from "./api.js";
import { standingInstructions } from "./engine.js";
import { opencodeBin, parseEvents, requireOpencode } from "./live-support.js";
import { openThreadStore } from "./thread-store.js";

const live = process.env.COMPANION_LIVE === "1";

test.skipIf(!live)(
  "a message streams a full OpenCode turn",
  async () => {
    requireOpencode();
    const directory = mkdtempSync(join(tmpdir(), "companion-live-"));
    const storePath = join(directory, "threads.db");
    const daemon = await startDaemon({
      storePath,
      opencodeBin,
    });
    try {
      const created = await fetch(`${daemon.url}/bots`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Content" }),
      });
      expect(created.status).toBe(201);
      const bot = (await created.json()) as BotView;
      const opened = (await (
        await fetch(`${daemon.url}/bots/${bot.id}`)
      ).json()) as BotTranscript;
      expect(replyText(opened.updates)).toContain("Content");
      const word = `marigold-${randomUUID().slice(0, 8)}`;
      writeFileSync(join(bot.directory, "note.txt"), `${word}\n`, "utf8");

      const response = await fetch(`${daemon.url}/bots/${bot.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Read note.txt in the working directory with a file-reading tool, then reply with only the exact word in that file.",
        }),
      });
      expect(response.status).toBe(200);
      const events = parseEvents(await response.text());
      const failure = events.find((event) => event.event === "error");
      expect(failure, JSON.stringify(events)).toBeUndefined();
      const updates = events.flatMap((event) =>
        event.event === "update" ? [event.data] : [],
      );
      const done = events.find((event) => event.event === "done");
      expect(replyText(updates), JSON.stringify(events)).toContain(word);
      expect(hasToolCall(updates), JSON.stringify(events)).toBe(true);
      expect(done, JSON.stringify(events)).toEqual({
        event: "done",
        data: { stopReason: "end_turn" },
      });

      const stored = await fetch(`${daemon.url}/bots/${bot.id}`);
      const transcript = (await stored.json()) as BotTranscript;
      expect(transcript.updates.slice(0, opened.updates.length)).toEqual(
        opened.updates,
      );
      expect(transcript.updates.slice(opened.updates.length)).toEqual(updates);
    } finally {
      await daemon.close();
    }

    const store = openThreadStore(storePath);
    try {
      const threads = store.listThreads();
      expect(threads).toHaveLength(1);
      expect(threads[0]?.sessionId).toEqual(expect.any(String));
      expect(threads[0]?.engine).toBe("opencode");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  360_000,
);

test.skipIf(!live)(
  "a current question is answered from the free web search pool",
  async () => {
    requireOpencode();
    const directory = mkdtempSync(join(tmpdir(), "companion-live-search-"));
    const daemon = await startDaemon({
      storePath: join(directory, "threads.db"),
      opencodeBin,
    });
    try {
      const config = JSON.parse(
        readFileSync(
          join(directory, "opencode-config", "opencode", "opencode.json"),
          "utf8",
        ),
      ) as { websearch: { provider: string } };
      expect(config.websearch).toEqual({ provider: "random" });
      const created = await fetch(`${daemon.url}/bots`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Scout" }),
      });
      expect(created.status).toBe(201);
      const bot = (await created.json()) as BotView;
      const updates = await liveTurn(
        daemon.url,
        bot.id,
        "Search the web for the latest stable Bun release. Reply with the version and the page URL you used.",
      );
      const search = webSearchResult(updates);
      expect(search.completed, JSON.stringify(updates)).toBe(true);
      expect(search.failed, JSON.stringify(updates)).toBe(false);
      const reply = replyText(updates);
      expect(reply, JSON.stringify(updates)).toMatch(/https?:\/\//);
      expect(reply, JSON.stringify(updates)).toMatch(/bun/i);
    } finally {
      await daemon.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  480_000,
);

test.skipIf(!live)(
  "two bots keep separate files and context",
  async () => {
    requireOpencode();
    const directory = mkdtempSync(join(tmpdir(), "companion-live-bots-"));
    const storePath = join(directory, "threads.db");
    const wordA = `marigold-${randomUUID()}`;
    const wordB = `cobalt-${randomUUID()}`;
    let created: { ada: BotView; bea: BotView } | undefined;
    try {
      const daemon = await startDaemon({ storePath, opencodeBin });
      try {
        const [ada, bea] = await Promise.all([
          createDescribedBot(daemon.url, "Ada", wordA),
          createDescribedBot(daemon.url, "Bea", wordB),
        ]);
        const adaReply = replyText(
          (await transcript(daemon.url, ada.id)).updates,
        );
        const beaReply = replyText(
          (await transcript(daemon.url, bea.id)).updates,
        );
        expect(ada.directory).not.toBe(bea.directory);
        expectFile(join(ada.directory, "AGENTS.md"), wordA, wordB, adaReply);
        expectFile(join(bea.directory, "AGENTS.md"), wordB, wordA, beaReply);
        expect(adaReply).toContain(wordA);
        expect(adaReply).not.toContain(wordB);
        expect(beaReply).toContain(wordB);
        expect(beaReply).not.toContain(wordA);
        expect(
          readFileSync(
            join(directory, "opencode-config", "opencode", "AGENTS.md"),
            "utf8",
          ),
        ).toBe(standingInstructions());
        expectFile(join(ada.directory, "MEMORY.md"), wordA, wordB, adaReply);
        expectFile(join(bea.directory, "MEMORY.md"), wordB, wordA, beaReply);
        created = { ada, bea };
      } finally {
        await daemon.close();
      }
      if (created === undefined) {
        throw new Error("The two bots were not created.");
      }
      const { ada, bea } = created;

      const restarted = await startDaemon({ storePath, opencodeBin });
      try {
        const ask =
          "Read AGENTS.md and MEMORY.md in the working directory with your file tools. Reply with only the code word those files contain.";
        const [adaTurn, beaTurn] = await Promise.all([
          liveTurn(restarted.url, ada.id, ask),
          liveTurn(restarted.url, bea.id, ask),
        ]);
        expect(replyText(adaTurn), JSON.stringify(adaTurn)).toContain(wordA);
        expect(replyText(adaTurn)).not.toContain(wordB);
        expect(hasToolCall(adaTurn), JSON.stringify(adaTurn)).toBe(true);
        expect(replyText(beaTurn), JSON.stringify(beaTurn)).toContain(wordB);
        expect(replyText(beaTurn)).not.toContain(wordA);
        expect(hasToolCall(beaTurn), JSON.stringify(beaTurn)).toBe(true);
        expectFile(
          join(ada.directory, "MEMORY.md"),
          wordA,
          wordB,
          replyText(adaTurn),
        );
        expectFile(
          join(bea.directory, "MEMORY.md"),
          wordB,
          wordA,
          replyText(beaTurn),
        );
      } finally {
        await restarted.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  900_000,
);

/** Creates a bot whose description tells it to store one code word. */
async function createDescribedBot(
  url: string,
  name: string,
  word: string,
): Promise<BotView> {
  const description = `The code word is ${word}. Use your file tools to write AGENTS.md in the working directory containing exactly the line "code word: ${word}". Write MEMORY.md containing exactly the line "code word: ${word}". Then reply with only ${word}.`;
  const created = await fetch(`${url}/bots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, description }),
  });
  expect(created.status, await created.clone().text()).toBe(201);
  return (await created.json()) as BotView;
}

async function transcript(url: string, botId: string): Promise<BotTranscript> {
  const response = await fetch(`${url}/bots/${botId}`);
  expect(response.status).toBe(200);
  return (await response.json()) as BotTranscript;
}

/**
 * Whether a web search in this turn finished.
 * OpenCode titles the call with the provider it picked, such as "Web Search via Exa".
 */
function webSearchResult(updates: readonly acp.SessionUpdate[]): {
  completed: boolean;
  failed: boolean;
} {
  const ids = new Set<string>();
  let completed = false;
  let failed = false;
  for (const update of updates) {
    if (
      update.sessionUpdate !== "tool_call" &&
      update.sessionUpdate !== "tool_call_update"
    ) {
      continue;
    }
    const named =
      ("name" in update && update.name === "websearch") ||
      ("title" in update &&
        typeof update.title === "string" &&
        /web search/i.test(update.title));
    if (update.sessionUpdate === "tool_call" && named)
      ids.add(update.toolCallId);
    if (!named && !ids.has(update.toolCallId)) continue;
    if (update.sessionUpdate === "tool_call") ids.add(update.toolCallId);
    if (update.status === "completed") completed = true;
    if (update.status === "failed") failed = true;
  }
  return { completed, failed };
}

/** One live turn, as the session updates the engine sent. */
async function liveTurn(
  url: string,
  botId: string,
  text: string,
): Promise<acp.SessionUpdate[]> {
  const response = await fetch(`${url}/bots/${botId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  expect(response.status).toBe(200);
  const events = parseEvents(await response.text());
  const failure = events.find((event) => event.event === "error");
  expect(failure, JSON.stringify(events)).toBeUndefined();
  expect(
    events.find((event) => event.event === "done"),
    JSON.stringify(events),
  ).toEqual({
    event: "done",
    data: { stopReason: "end_turn" },
  });
  return events.flatMap((event) =>
    event.event === "update" ? [event.data] : [],
  );
}

/** The file a bot was supposed to write, or a failure that includes its reply. */
function expectFile(
  path: string,
  word: string,
  other: string,
  reply: string,
): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Missing ${path}. Reply was: ${reply}. ${String(error)}`);
  }
  expect(text, reply).toContain(word);
  expect(text, reply).not.toContain(other);
}
