"use client";

/**
 * The sign-in page. A few of the bot pictures stay on screen and keep moving.
 * Google is the way in. The email form sits under it only while developing,
 * so an agent can fill a normal email and password.
 */
import { signInWithGoogle, signInWithPassword } from "@/app/auth/actions";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { BotAvatar as ChosenAvatar } from "@companion/shared/avatar";
import { useActionState } from "react";

const pictures: { avatar: ChosenAvatar; size: number }[] = [
  { avatar: { shape: "ghost", color: "#8b5cf6" }, size: 72 },
  { avatar: { shape: "controller", color: "#1f7cf2" }, size: 104 },
  { avatar: { shape: "star", color: "#f8a01c" }, size: 72 },
];

export function Landing({
  notice,
  passwordForm,
}: {
  notice: string | null;
  passwordForm: boolean;
}) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="flex w-full max-w-sm flex-col items-center">
        <div aria-hidden className="flex items-end justify-center gap-3">
          {pictures.map((picture) => (
            <BotAvatar
              avatar={picture.avatar}
              key={picture.avatar.shape}
              size={picture.size}
            />
          ))}
        </div>
        <h1 className="mt-8 text-lg font-medium">Companion</h1>
        {notice ? (
          <p className="mt-3 text-center text-destructive text-sm" role="alert">
            {notice}
          </p>
        ) : null}
        <form action={signInWithGoogle} className="mt-8 w-full">
          <Button className="h-10 w-full" type="submit" variant="outline">
            <GoogleMark />
            Sign in with Google
          </Button>
        </form>
        {passwordForm ? <DevSignIn /> : null}
      </div>
    </main>
  );
}

function DevSignIn() {
  const [state, action, pending] = useActionState(signInWithPassword, {
    error: "",
  });
  return (
    <form
      action={action}
      className="mt-6 flex w-full flex-col gap-3 border-t pt-6"
    >
      <div className="flex flex-col gap-2">
        <label
          className="text-muted-foreground text-sm"
          htmlFor="sign-in-email"
        >
          Email
        </label>
        <Input
          autoComplete="username"
          id="sign-in-email"
          name="email"
          required
          type="email"
        />
      </div>
      <div className="flex flex-col gap-2">
        <label
          className="text-muted-foreground text-sm"
          htmlFor="sign-in-password"
        >
          Password
        </label>
        <Input
          autoComplete="current-password"
          id="sign-in-password"
          name="password"
          required
          type="password"
        />
      </div>
      {state.error !== "" ? (
        <p className="text-destructive text-sm" role="alert">
          {state.error}
        </p>
      ) : null}
      <Button disabled={pending} type="submit">
        {pending ? "Signing in" : "Sign in"}
      </Button>
    </form>
  );
}

function GoogleMark() {
  return (
    <svg aria-hidden className="size-4" viewBox="0 0 48 48">
      <path
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z"
        fill="#FFC107"
      />
      <path
        d="M6.3 14.7l6.6 4.8C14.7 16 19 12 24 12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 16.3 4 9.6 8.3 6.3 14.7z"
        fill="#FF3D00"
      />
      <path
        d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.3 35.1 26.8 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
        fill="#4CAF50"
      />
      <path
        d="M43.6 20.5H42V20H24v8h11.3c-1.1 3.2-3.5 5.7-6.6 7.1l6.3 5.3C37.4 38.4 44 33 44 24c0-1.2-.1-2.3-.4-3.5z"
        fill="#1976D2"
      />
    </svg>
  );
}
