"use client";

/**
 * The screen a new person sees while their computer is being made, and what
 * they see if that does not work out. It is friendly on purpose: it says the
 * wait happens once and never mentions servers. It polls for progress, and
 * when the computer is ready it shows a happy beat and then opens the app.
 */
import { AccountMenu } from "@/components/account-menu";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import { nextLook, turnStatusIntervalMs } from "@/lib/turn-status";
import type { BotAvatar as ChosenAvatar } from "@companion/shared/avatar";
import type { VmStatus } from "@companion/shared/vm";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** Different from the sign-in trio: a rocket, a cloud and a bunny. */
const pictures: { avatar: ChosenAvatar; size: number }[] = [
  { avatar: { shape: "rocket", color: "#ff6a1a" }, size: 72 },
  { avatar: { shape: "cloud", color: "#1f7cf2" }, size: 104 },
  { avatar: { shape: "bunny", color: "#ec4899" }, size: 72 },
];

/** Friendly progress lines. The last one stays, so the screen never claims more than it knows. */
const lines = [
  "Unpacking your new computer",
  "Getting your assistants' desks ready",
  "Warming things up",
  "Almost there",
] as const;

const pollMs = 3000;
/** How long the happy beat lasts before the app opens. */
const happyMs = 1500;

export function VmSetup({
  initial,
  avatarUrl,
}: {
  initial: VmStatus;
  avatarUrl: string | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<VmStatus>(initial);
  const [line, setLine] = useState(0);
  const [looks, setLooks] = useState(() => pictures.map(() => nextLook()));

  // Ask for progress until the computer is ready; stop while the screen shows a failure.
  useEffect(() => {
    if (status !== "setting-up") return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const response = await fetch("/api/vm");
        if (!response.ok) return;
        const body = (await response.json()) as { status: VmStatus };
        if (!cancelled) setStatus(body.status);
      } catch {
        // A dropped request is just a missed poll.
      }
    }, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [status]);

  // Open the app after the happy beat.
  useEffect(() => {
    if (status !== "ready") return;
    const timer = setTimeout(() => router.refresh(), happyMs);
    return () => clearTimeout(timer);
  }, [status, router]);

  // Rotating line and glances, only while waiting.
  useEffect(() => {
    if (status !== "setting-up") return;
    const lineTimer = setInterval(
      () => setLine((n) => Math.min(n + 1, lines.length - 1)),
      turnStatusIntervalMs,
    );
    const lookTimer = setInterval(
      () => setLooks((all) => all.map((look) => nextLook(look))),
      1100,
    );
    return () => {
      clearInterval(lineTimer);
      clearInterval(lookTimer);
    };
  }, [status]);

  async function tryAgain() {
    setStatus("setting-up");
    setLine(0);
    await fetch("/api/vm", { method: "POST" }).catch(() => undefined);
  }

  const mood =
    status === "ready" ? "happy" : status === "failed" ? "idle" : "thinking";
  const heading =
    status === "ready"
      ? "All set!"
      : status === "failed"
        ? "That took longer than expected"
        : "Setting up your computer";

  return (
    <div className="flex flex-1 flex-col">
      <main
        aria-live="polite"
        className="flex flex-1 flex-col items-center justify-center px-6 py-16"
        data-vm-status={status}
        role="status"
      >
        <div className="flex w-full max-w-sm flex-col items-center text-center">
          <div aria-hidden className="flex items-end justify-center gap-3">
            {pictures.map((picture, index) => (
              <BotAvatar
                avatar={picture.avatar}
                followPointer={false}
                key={picture.avatar.shape}
                lookAt={status === "setting-up" ? looks[index] : null}
                mood={mood}
                size={picture.size}
              />
            ))}
          </div>
          <h1 className="mt-8 font-medium text-lg">{heading}</h1>
          {status === "setting-up" ? (
            <>
              <p className="mt-3 text-muted-foreground text-sm">
                This only happens once, and it can take a minute or two. You can
                leave this page open.
              </p>
              <p
                className="turn-status-line mt-4 text-muted-foreground text-sm"
                key={line}
              >
                {lines[line]}
              </p>
            </>
          ) : null}
          {status === "failed" ? (
            <>
              <p className="mt-3 text-muted-foreground text-sm">
                Your computer didn&apos;t finish setting up. Nothing is lost,
                and it&apos;s safe to try again.
              </p>
              <Button className="mt-6" onClick={tryAgain}>
                Try again
              </Button>
            </>
          ) : null}
        </div>
      </main>
      <div className="p-2">
        <AccountMenu avatarUrl={avatarUrl} />
      </div>
    </div>
  );
}
