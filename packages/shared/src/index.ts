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
 * outcome after the stream has closed. A running turn's `replyFrom` is the
 * index of its first reply update in the transcript, after the person's own
 * message, so a client that rejoins can show what came before and replay the rest.
 */
export type TurnState =
  | { status: "idle" }
  | { status: "running"; replyFrom: number }
  | { status: "finished"; stopReason: acp.StopReason }
  | { status: "failed"; error: string };

/** A bot, its stored session updates, and the state of its latest turn. */
export type BotTranscript = BotView & {
  updates: acp.SessionUpdate[];
  turn: TurnState;
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

/**
 * Where the one shared Chrome listens, as the daemon tells a bot's `browser`
 * command. `generation` changes each time Chrome is started, so a command knows
 * its window died with the old process and needs a new one.
 */
export type BrowserEndpoint = {
  port: number;
  generation: string;
};

/** What the daemon returns to one bot's `browser` command: the shared Chrome and its own session name. */
export type BrowserLease = BrowserEndpoint & {
  session: string;
};

/**
 * The shared screen, as the daemon tells a bot's `desktop` command.
 * The command uses this to point the desktop tool at the right screen and to
 * take the one lock every bot shares. It does not print the display to the bot.
 */
export type DesktopSession = {
  display: string;
  dbusAddress: string;
  generation: string;
  /** A private name for this bot's snapshot refs. */
  session: string;
  /** A directory the command creates to hold the shared desktop lock. */
  lockPath: string;
};

/** One window the daemon opened for a bot. */
export type DesktopWindow = {
  windowId: string;
  /** The allow-list name, `form` or `mousepad`. */
  app: string;
  /** The name the desktop tool uses for the same app. */
  toolApp: string;
  pid: number;
  title: string;
};

/** What one bot's `desktop` command may act on: the screen, and only its windows. */
export type DesktopLease = DesktopSession & {
  windows: DesktopWindow[];
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
  imageMimeTypes,
  isImageMime,
  maxImageBytes,
  maxImagesPerMessage,
  parseTurnEvent,
  parseTurnEvents,
  type AttachedImage,
  type ImageMimeType,
  type TurnEvent,
} from "./protocol.js";
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
