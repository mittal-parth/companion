/**
 * Maps an engine permission request to an approval the user can allow or deny.
 * The engine stays blocked until that decision is delivered.
 */
import type * as acp from "@agentclientprotocol/sdk";
import type {
  Approval,
  ApprovalDecision,
  HeldApproval,
} from "@companion/shared";

/** Reads the session and tool call the engine is asking about. */
export function approvalFrom(request: acp.RequestPermissionRequest): Approval {
  return {
    sessionId: request.sessionId,
    toolCallId: request.toolCall.toolCallId,
    ...(request.toolCall.title ? { title: request.toolCall.title } : {}),
  };
}

/**
 * Turns an allow or deny into the engine's permission response.
 * Allow prefers a one-time option. Deny prefers a one-time rejection.
 * A missing option cancels the request.
 */
export function approvalResponse(
  options: readonly acp.PermissionOption[],
  decision: ApprovalDecision,
): acp.RequestPermissionResponse {
  const kinds =
    decision === "allow"
      ? (["allow_once", "allow_always"] as const)
      : (["reject_once", "reject_always"] as const);
  for (const kind of kinds) {
    const option = options.find((item) => item.kind === kind);
    if (option) {
      return { outcome: { outcome: "selected", optionId: option.optionId } };
    }
  }
  return { outcome: { outcome: "cancelled" } };
}

/** Keeps the engine waiting until `answer` is called. */
export function holdApproval(
  request: acp.RequestPermissionRequest,
): HeldApproval {
  let settle: (decision: ApprovalDecision) => void = () => {};
  const decision = new Promise<ApprovalDecision>((resolve) => {
    settle = resolve;
  });
  return {
    approval: approvalFrom(request),
    answer(next) {
      settle(next);
    },
    result: decision.then((next) => approvalResponse(request.options, next)),
  };
}

/**
 * The permissions one engine is holding for the chat.
 * Each stays blocked until that bot's tool call is allowed or denied.
 * Denying the ones still open lets a cancelled turn finish.
 */
export function createApprovalGate(): {
  hold(
    botId: string,
    request: acp.RequestPermissionRequest,
    onApproval: (approval: Approval) => void,
  ): Promise<acp.RequestPermissionResponse>;
  answer(
    botId: string,
    toolCallId: string,
    decision: ApprovalDecision,
  ): boolean;
  denyWaiting(botId: string): void;
} {
  const waiting = new Map<string, Map<string, HeldApproval>>();

  const take = (
    botId: string,
    toolCallId: string,
  ): HeldApproval | undefined => {
    const tools = waiting.get(botId);
    const held = tools?.get(toolCallId);
    tools?.delete(toolCallId);
    return held;
  };

  return {
    hold(botId, request, onApproval) {
      const held = holdApproval(request);
      const tools = waiting.get(botId) ?? new Map<string, HeldApproval>();
      waiting.set(botId, tools);
      tools.set(held.approval.toolCallId, held);
      onApproval(held.approval);
      return held.result.finally(() => {
        tools.delete(held.approval.toolCallId);
      });
    },
    answer(botId, toolCallId, decision) {
      const held = take(botId, toolCallId);
      if (held === undefined) return false;
      held.answer(decision);
      return true;
    },
    denyWaiting(botId) {
      const tools = waiting.get(botId);
      if (tools === undefined) return;
      for (const toolCallId of [...tools.keys()]) {
        take(botId, toolCallId)?.answer("deny");
      }
    },
  };
}
