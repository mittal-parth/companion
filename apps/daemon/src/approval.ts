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
