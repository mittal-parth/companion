/**
 * Shared types for a recorded engine turn and for an approval.
 * Session fields match what OpenCode sent, stored in the hello fixture.
 */
import type * as acp from "@agentclientprotocol/sdk";

export const sharedPackage = "@companion/shared" as const;

/** The user's decision on a sensitive action. */
export type ApprovalDecision = "allow" | "deny";

/** A sensitive action waiting for the user. */
export type Approval = {
  sessionId: string;
  toolCallId: string;
  title?: string;
};

/** The engine request held open, and the way the user answers it. */
export type HeldApproval = {
  approval: Approval;
  answer(decision: ApprovalDecision): void;
  result: Promise<acp.RequestPermissionResponse>;
};

/** One recorded OpenCode turn: the initialize result, the session, and the prompt stream. */
export type RecordedSession = {
  initialize: acp.InitializeResponse;
  newSession: acp.NewSessionResponse;
  updates: acp.SessionUpdate[];
  permissions: Array<{
    request: acp.RequestPermissionRequest;
    response: acp.RequestPermissionResponse;
  }>;
  prompt: acp.PromptResponse;
  /** Present once a turn has been cancelled. `session/cancel` stops with this reason. */
  cancel?: {
    stopReason: acp.StopReason;
    _meta?: Record<string, unknown>;
  };
};
