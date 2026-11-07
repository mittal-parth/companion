import * as acp from "@agentclientprotocol/sdk";
import type { HeldApproval } from "@companion/shared";
import { expect, test } from "vitest";
import { approvalFrom, approvalResponse, holdApproval } from "./approval.js";

const secret = "pebble";
const sessionId = "ses_test";
const toolCallId = "call-1";

const options: acp.PermissionOption[] = [
  { optionId: "once", name: "Allow once", kind: "allow_once" },
  { optionId: "always", name: "Allow always", kind: "allow_always" },
  { optionId: "no", name: "Reject", kind: "reject_once" },
];

test("an approval names the session and the tool call", () => {
  expect(
    approvalFrom({
      sessionId,
      toolCall: { toolCallId, title: "read" },
      options,
    }),
  ).toEqual({ sessionId, toolCallId, title: "read" });
});

test("allow picks a one-time option and deny picks a rejection", () => {
  expect(approvalResponse(options, "allow")).toEqual({
    outcome: { outcome: "selected", optionId: "once" },
  });
  expect(approvalResponse(options, "deny")).toEqual({
    outcome: { outcome: "selected", optionId: "no" },
  });
  expect(approvalResponse([], "deny")).toEqual({
    outcome: { outcome: "cancelled" },
  });
});

test("the engine stays blocked until the approval is answered", async () => {
  const held = holdApproval({
    sessionId,
    toolCall: { toolCallId, title: "read" },
    options,
  });
  let answered = false;
  const pending = held.result.then(() => {
    answered = true;
  });
  await Promise.resolve();
  expect(answered).toBe(false);
  held.answer("deny");
  await pending;
  expect(answered).toBe(true);
});

test("a denial stops the tool call", async () => {
  const turn = await runFakeTurn("deny");
  expect(turn.toolStatus).toBe("failed");
  expect(turn.stopReason).toBe("cancelled");
  expect(turn.updates.join(" ")).not.toContain(secret);
});

test("an allow lets the tool call finish", async () => {
  const turn = await runFakeTurn("allow");
  expect(turn.toolStatus).toBe("completed");
  expect(turn.stopReason).toBe("end_turn");
  expect(turn.updates.join(" ")).toContain(secret);
});

test("cancel stops a turn that is waiting on an approval", async () => {
  const turn = await runFakeTurn("cancel");
  expect(turn.toolStatus).toBe("failed");
  expect(turn.stopReason).toBe("cancelled");
  expect(turn.updates.join(" ")).not.toContain(secret);
});

test("a loaded session continues after the engine connection is replaced", async () => {
  const store = new Map<string, string[]>();
  const first = makeAgent(store);
  const client = acp.client({ name: "companion" });
  const created = await client.connectWith(first, async (ctx) => {
    await initialize(ctx);
    const session = await ctx.request(acp.methods.agent.session.new, {
      cwd: "/tmp/companion",
      mcpServers: [],
    });
    await ctx.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "one" }],
    });
    return session.sessionId;
  });

  const second = makeAgent(store);
  const prompts = await acp
    .client({ name: "companion" })
    .connectWith(second, async (ctx) => {
      await initialize(ctx);
      await ctx.request(acp.methods.agent.session.load, {
        sessionId: created,
        cwd: "/tmp/companion",
        mcpServers: [],
      });
      await ctx.request(acp.methods.agent.session.prompt, {
        sessionId: created,
        prompt: [{ type: "text", text: "two" }],
      });
      return store.get(created);
    });
  expect(prompts).toEqual(["one", "two"]);
});

type FakeTurn = {
  toolStatus: string;
  stopReason: string;
  updates: string[];
};

/** Runs one prompt against an in-process engine that asks before reading. */
async function runFakeTurn(
  decision: "allow" | "deny" | "cancel",
): Promise<FakeTurn> {
  const updates: string[] = [];
  let toolStatus = "pending";
  let held: HeldApproval | undefined;
  const client = acp
    .client({ name: "companion" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
      held = holdApproval(ctx.params);
      return held.result;
    })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      const update = ctx.params.update;
      if (update.sessionUpdate === "tool_call_update" && update.status) {
        toolStatus = update.status;
      }
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      ) {
        updates.push(update.content.text);
      }
    });

  const agent = acp
    .agent({ name: "fake" })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
    }))
    .onRequest(acp.methods.agent.session.new, () => ({ sessionId }))
    .onNotification(acp.methods.agent.session.cancel, () => {
      held?.answer("deny");
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const response = await ctx.client.request(
        acp.methods.client.session.requestPermission,
        {
          sessionId,
          toolCall: { toolCallId, title: "read", status: "pending" },
          options,
        },
      );
      const denied =
        response.outcome.outcome === "cancelled" ||
        (response.outcome.outcome === "selected" &&
          response.outcome.optionId === "no");
      if (denied) {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "failed",
          },
        });
        return { stopReason: "cancelled" as const };
      }
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "completed",
        },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: secret },
        },
      });
      return { stopReason: "end_turn" as const };
    });

  const stopReason = await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    await ctx.request(acp.methods.agent.session.new, {
      cwd: "/tmp/companion",
      mcpServers: [],
    });
    const pending = ctx.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "read the secret" }],
    });
    await waitForHeld();
    if (decision === "cancel") {
      await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
    } else {
      held?.answer(decision);
    }
    return (await pending).stopReason;
  });

  return { toolStatus, stopReason, updates };

  async function waitForHeld(): Promise<void> {
    for (let i = 0; i < 20 && !held; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!held) throw new Error("The engine did not ask for an approval.");
  }
}

function makeAgent(store: Map<string, string[]>) {
  return acp
    .agent({ name: "fake" })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
    }))
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      store.set(sessionId, []);
      return { sessionId, meta: { cwd: ctx.params.cwd } };
    })
    .onRequest(acp.methods.agent.session.load, (ctx) => {
      if (!store.has(ctx.params.sessionId)) {
        throw new Error("Unknown session.");
      }
      return {};
    })
    .onRequest(acp.methods.agent.session.prompt, (ctx) => {
      const prompts = store.get(ctx.params.sessionId);
      const block = ctx.params.prompt.find((item) => item.type === "text");
      if (prompts && block && block.type === "text") prompts.push(block.text);
      return { stopReason: "end_turn" as const };
    });
}

function initialize(ctx: acp.ClientContext) {
  return ctx.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: { name: "companion", version: "0.0.0" },
  });
}
