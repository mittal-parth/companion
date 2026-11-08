/**
 * Shared types for bots, threads, a recorded engine turn, and an approval.
 * Session update fields match what OpenCode sent, stored in the hello fixture.
 */
import type * as acp from "@agentclientprotocol/sdk";

export const sharedPackage = "@companion/shared" as const;

/** Engines a bot can run. A thread remembers which one owns its session. */
export const engineNames = ["opencode", "claude", "codex"] as const;

export type EngineName = (typeof engineNames)[number];

/** A named agent. New threads copy its engine, then keep their own. */
export type Bot = {
  id: string;
  name: string;
  engine: EngineName;
};

/**
 * One conversation. `updates` is the transcript, in the order the engine sent it.
 * `engine`, `sessionId`, and `cwd` are what a restart uses to start that engine
 * and call `session/load`. `sessionId` is empty until the engine has a session.
 */
export type Thread = {
  id: string;
  botId: string;
  engine: EngineName;
  sessionId: string | null;
  cwd: string;
  updates: acp.SessionUpdate[];
};

/** A thread as a list shows it, without the transcript. */
export type ThreadSummary = Omit<Thread, "updates">;

/** Which engine to start, and the session and directory to load. */
export type ThreadResume = {
  engine: EngineName;
  sessionId: string;
  cwd: string;
};

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
