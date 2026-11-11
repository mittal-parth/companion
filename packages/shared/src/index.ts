/**
 * Shared types for bots, threads, a recorded engine turn, an approval, a schedule,
 * and the receipt that records what the daemon decided for one slot.
 * Session update fields match what OpenCode sent, stored in the hello fixture.
 */
import type * as acp from "@agentclientprotocol/sdk";
import type { Schedule } from "./schedule.js";

export const sharedPackage = "@companion/shared" as const;

/**
 * Engines a bot can run. A thread remembers which one owns its session.
 * Call sites use these names so the set stays in one place.
 */
export const engines = {
  opencode: "opencode",
  claude: "claude",
  codex: "codex",
} as const;

export const engineNames = [
  engines.opencode,
  engines.claude,
  engines.codex,
] as const;

export type EngineName = (typeof engines)[keyof typeof engines];

/** A named agent. Its conversation keeps the engine it started with. */
export type Bot = {
  id: string;
  name: string;
  engine: EngineName;
};

/**
 * A bot as the local API shows it.
 * The directory is the one folder that conversation works in.
 */
export type BotView = Bot & {
  directory: string;
};

/**
 * The latest turn for a bot, as a client reads it back.
 * `idle` means none has run. `running` means the daemon is still in one,
 * whether or not a client is connected. `finished` and `failed` keep the
 * outcome after the stream has closed.
 */
export type TurnState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "finished"; stopReason: acp.StopReason }
  | { status: "failed"; error: string };

/** A bot, its stored session updates, and the state of its latest turn. */
export type BotTranscript = BotView & {
  updates: acp.SessionUpdate[];
  turn: TurnState;
};

/**
 * One server-sent event from a turn.
 * `update` is an ACP session update, in arrival order.
 * `done` is why the prompt stopped. `error` means the turn failed.
 */
export type TurnEvent =
  | { event: "update"; data: acp.SessionUpdate }
  | { event: "done"; data: { stopReason: acp.StopReason } }
  | { event: "error"; data: { error: string } };

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

/**
 * What the daemon decided for one slot.
 * `ran` means the turn came back. `skipped` means the slot was too late to send.
 * A run of skipped slots is the stretch where the daemon was not firing.
 */
export type ScheduleReceiptOutcome = "ran" | "skipped";

/** One decided slot, in the order the schedule named it. */
export type ScheduleReceipt = {
  occurrence: number;
  outcome: ScheduleReceiptOutcome;
};

/** The user's decision on a sensitive action. */
export type ApprovalDecision = "allow" | "deny";

/**
 * A pasted image.
 * `data` is the file's base64, with no `data:` prefix, so a text-only model
 * can be handed a path instead of the bytes.
 */
export type AttachedImage = {
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
};

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

/** A schedule as the agent API shows it. Times are ISO-8601 UTC strings. */
export type ScheduleListing = Schedule & {
  paused: boolean;
  /** The next slot, or null when the schedule is paused or has no slot left. */
  nextRunAt: string | null;
  /** The latest slot whose turn came back, or null if none has. */
  lastRunAt: string | null;
};

/** What the `schedule` CLI reads from `<bot folder>/.companion/schedule.json`. */
export type ScheduleAccess = {
  url: string;
  token: string;
};

/** One line of the schedule log, so a firing can be traced afterwards. */
export type ScheduleLogEntry = {
  event:
    | "created"
    | "deleted"
    | "paused"
    | "resumed"
    | "armed"
    | "fired"
    | "completed"
    | "failed"
    | "skipped_paused"
    | "skipped_duplicate";
  scheduleId: string;
  botId: string;
  /** When the line was logged, in epoch milliseconds. */
  at: number;
  /** The slot the line is about, in epoch milliseconds. */
  occurrence?: number;
  /** The stop reason or the error message. */
  detail?: string;
};

/** A `schedule` CLI command once its arguments have been read. */
export type ScheduleCommand =
  | { command: "create"; body: Record<string, unknown> }
  | { command: "list" }
  | { command: "pause"; id: string }
  | { command: "resume"; id: string }
  | { command: "delete"; id: string }
  | { command: "help" };

export {
  nextRun,
  nextRuns,
  validateSchedule,
  type CronSchedule,
  type IntervalSchedule,
  type OnceSchedule,
  type Schedule,
  type ScheduleValidation,
  type ScheduleWindow,
} from "./schedule.js";
