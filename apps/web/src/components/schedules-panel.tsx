"use client";

/**
 * The open bot's schedules, in a column on the right of the chat.
 * Each row can be turned on or off. The next run and the last receipt are
 * shown. Creating or changing a schedule stays in the conversation.
 */
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { ScheduleView } from "@/lib/schedules";
import type { BotAvatar as ChosenAvatar } from "@companion/shared/avatar";
import { CircleCheckIcon, CircleIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

export function SchedulesPanel({
  botId,
  name,
  avatar,
  onClose,
}: {
  botId: string;
  name: string;
  avatar: ChosenAvatar;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<ScheduleView[]>();
  const [error, setError] = useState<string>();
  const [pendingId, setPendingId] = useState<string>();

  useEffect(() => {
    let cancel = false;
    void load(botId).then(
      (loaded) => {
        if (!cancel) setRows(loaded);
      },
      (reason: unknown) => {
        if (!cancel) {
          setError(
            reason instanceof Error
              ? reason.message
              : "The schedules could not be read.",
          );
        }
      },
    );
    return () => {
      cancel = true;
    };
  }, [botId]);

  return (
    <aside
      aria-label="Schedules"
      className="flex w-80 shrink-0 flex-col border-l bg-background"
    >
      <div className="relative flex items-center gap-3 px-4 pt-4 pr-12 pb-2">
        <BotAvatar avatar={avatar} size={64} />
        <p className="min-w-0 truncate text-lg font-medium">{name}</p>
        <Button
          aria-label="Close schedules"
          className="absolute top-3 right-3"
          onClick={onClose}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>
      <h2 className="px-4 pt-4 pb-1 text-sm font-medium">Schedules</h2>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p className="px-4 py-3 text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}
        {rows === undefined && error === undefined ? (
          <p className="px-4 py-6 text-muted-foreground text-sm">Loading</p>
        ) : null}
        {rows?.length === 0 ? (
          <p className="px-4 py-6 text-center text-muted-foreground text-sm">
            No schedules
          </p>
        ) : null}
        {rows !== undefined && rows.length > 0 ? (
          <ul>
            {rows.map((row) => (
              <li className="flex items-start gap-3 px-4 py-3" key={row.id}>
                {row.paused ? (
                  <CircleIcon
                    aria-hidden
                    className="mt-0.5 size-4 text-muted-foreground"
                  />
                ) : (
                  <CircleCheckIcon
                    aria-hidden
                    className="mt-0.5 size-4 text-emerald-600 dark:text-emerald-400"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p
                    className="truncate text-sm font-medium"
                    title={row.prompt}
                  >
                    {row.prompt}
                  </p>
                  <p className="text-muted-foreground text-sm">
                    {row.paused ? "Paused" : row.cadence}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Next run {formatWhen(row.nextRunAt, row.timeZone)}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Last receipt {formatWhen(row.lastRunAt, row.timeZone)}
                  </p>
                </div>
                <Switch
                  aria-label={`${row.paused ? "Enable" : "Disable"} ${row.prompt}`}
                  checked={!row.paused}
                  disabled={pendingId === row.id}
                  onCheckedChange={(checked) => {
                    void setEnabled(row, checked);
                  }}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </aside>
  );

  async function setEnabled(row: ScheduleView, enabled: boolean) {
    setPendingId(row.id);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/bots/${encodeURIComponent(botId)}/schedules/${encodeURIComponent(row.id)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled }),
        },
      );
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok || !isScheduleView(body)) {
        throw new Error(
          messageFrom(body, "The schedule could not be changed."),
        );
      }
      setRows((current) =>
        current?.map((item) => (item.id === body.id ? body : item)),
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The schedule could not be changed.",
      );
    } finally {
      setPendingId(undefined);
    }
  }
}

async function load(botId: string): Promise<ScheduleView[]> {
  const response = await fetch(
    `/api/bots/${encodeURIComponent(botId)}/schedules`,
  );
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isScheduleList(body)) {
    throw new Error(messageFrom(body, "The schedules could not be read."));
  }
  return body;
}

/** A clock time in the schedule's zone, or None when there is no instant. */
function formatWhen(iso: string | null, timeZone: string | null): string {
  if (iso === null) return "None";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "None";
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timeZone ?? undefined,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function messageFrom(body: unknown, fallback: string): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string" &&
    body.error !== ""
  ) {
    return body.error;
  }
  return fallback;
}

function isScheduleList(value: unknown): value is ScheduleView[] {
  return Array.isArray(value) && value.every(isScheduleView);
}

function isScheduleView(value: unknown): value is ScheduleView {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<ScheduleView>;
  return (
    typeof row.id === "string" &&
    typeof row.prompt === "string" &&
    typeof row.paused === "boolean" &&
    typeof row.cadence === "string" &&
    (row.nextRunAt === null || typeof row.nextRunAt === "string") &&
    (row.lastRunAt === null || typeof row.lastRunAt === "string") &&
    (row.timeZone === null || typeof row.timeZone === "string")
  );
}
