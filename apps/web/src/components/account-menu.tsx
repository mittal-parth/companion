"use client";

/**
 * The signed-in person, at the bottom of the sidebar.
 * The menu opens upward and only offers sign-out. The picture is the one
 * on the session. Without one, it is a plain profile icon.
 */
import { signOut } from "@/app/auth/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CircleUser } from "lucide-react";
import { useState, useTransition } from "react";

export function AccountMenu({ avatarUrl }: { avatarUrl: string | null }) {
  const [pictureFailed, setPictureFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  const picture = avatarUrl !== null && !pictureFailed;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Account"
          className="rounded-full"
          disabled={pending}
          size="icon"
          type="button"
          variant="ghost"
        >
          {picture ? (
            // The host is whatever the session sent, so it is not a next/image pattern.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              alt=""
              className="size-7 rounded-full object-cover"
              onError={() => setPictureFailed(true)}
              src={avatarUrl}
            />
          ) : (
            <CircleUser />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
        <DropdownMenuItem
          disabled={pending}
          onSelect={() => {
            startTransition(() => {
              void signOut();
            });
          }}
        >
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
