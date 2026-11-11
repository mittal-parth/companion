"use client";

/**
 * The sidebar of this computer's bots, and the conversation that is open.
 * Creating a bot waits for its greeting. A refresh opens the first bot again.
 */
import { Chat } from "@/components/chat";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import type { BotSummary, LoadedBot } from "@/lib/daemon";
import { PlusIcon } from "lucide-react";
import { useRef, useState } from "react";

export function BotShell({
  bots: initialBots,
  chat: initialChat,
}: {
  bots: BotSummary[];
  chat: LoadedBot;
}) {
  const [bots, setBots] = useState(initialBots);
  const [chat, setChat] = useState(initialChat);
  const [switching, setSwitching] = useState(false);
  const [shellError, setShellError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createError, setCreateError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(initialChat.name);
  const renameLock = useRef(false);
  const skipRename = useRef(false);

  return (
    <SidebarProvider className="h-svh">
      <Sidebar>
        <SidebarHeader className="flex-row items-center justify-between">
          <span className="px-2 text-sm font-medium">Bots</span>
          <Button
            aria-label="New bot"
            onClick={() => {
              setCreateError(undefined);
              setCreateOpen(true);
            }}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <PlusIcon />
          </Button>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {bots.map((bot) => (
                  <SidebarMenuItem key={bot.id}>
                    <SidebarMenuButton
                      isActive={bot.id === chat.id}
                      onClick={() => void openBot(bot.id)}
                      type="button"
                    >
                      <span className="truncate">{bot.name}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <SidebarInset className="min-h-0 overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2">
          <SidebarTrigger />
          <div className="min-w-0 flex-1">
            {renaming ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveRename();
                }}
              >
                <Input
                  aria-label="Bot name"
                  autoFocus
                  className="h-8 max-w-xs"
                  onBlur={() => void saveRename()}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    skipRename.current = true;
                    setRenaming(false);
                  }}
                  value={renameValue}
                />
              </form>
            ) : (
              <button
                aria-label={`Rename ${chat.name}`}
                className="truncate px-2 text-sm font-medium"
                onClick={() => {
                  setRenameValue(chat.name);
                  setShellError(undefined);
                  setRenaming(true);
                }}
                type="button"
              >
                {chat.name}
              </button>
            )}
          </div>
          <ThemeToggle className="shrink-0" />
        </header>
        {shellError ? (
          <p className="px-4 pt-2 text-destructive text-sm" role="alert">
            {shellError}
          </p>
        ) : null}
        <Chat
          botId={chat.id}
          failure={chat.failure}
          key={chat.id}
          locked={switching}
          messages={chat.messages}
          name={chat.name}
          replyFrom={chat.replyFrom}
          resume={chat.resume}
        />
      </SidebarInset>
      <Dialog open={createOpen} onOpenChange={closeCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create new bot</DialogTitle>
            <DialogDescription>
              Give it a name. It will greet you and ask what it is for.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createBot();
            }}
          >
            <Input
              aria-label="Name"
              autoComplete="off"
              autoFocus
              disabled={creating}
              onChange={(event) => setCreateName(event.target.value)}
              placeholder="Name your bot"
              value={createName}
            />
            {createError ? (
              <p className="pt-2 text-destructive text-sm" role="alert">
                {createError}
              </p>
            ) : null}
            <DialogFooter className="mt-4">
              <Button
                disabled={creating}
                onClick={() => closeCreate(false)}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button
                disabled={creating || createName.trim() === ""}
                type="submit"
              >
                {creating ? "Creating" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );

  function closeCreate(open: boolean) {
    if (!open && creating) return;
    setCreateOpen(open);
    if (!open) {
      setCreateName("");
      setCreateError(undefined);
    }
  }

  async function openBot(id: string) {
    if (id === chat.id || switching) return;
    setSwitching(true);
    setShellError(undefined);
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(id)}`);
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok || !isLoadedBot(body)) {
        throw new Error(messageFrom(body, "The bot could not be opened."));
      }
      setChat(body);
      setRenaming(false);
    } catch (error) {
      setShellError(
        error instanceof Error ? error.message : "The bot could not be opened.",
      );
    } finally {
      setSwitching(false);
    }
  }

  async function createBot() {
    const name = createName.trim();
    if (name === "" || creating) return;
    setCreating(true);
    setCreateError(undefined);
    try {
      const response = await fetch("/api/bots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok || !isLoadedBot(body)) {
        throw new Error(messageFrom(body, "The bot could not be created."));
      }
      setBots((list) => [...list, { id: body.id, name: body.name }]);
      setChat(body);
      setRenaming(false);
      setCreateName("");
      setCreateOpen(false);
    } catch (error) {
      setCreateError(
        error instanceof Error
          ? error.message
          : "The bot could not be created.",
      );
    } finally {
      setCreating(false);
    }
  }

  async function saveRename() {
    if (skipRename.current) {
      skipRename.current = false;
      return;
    }
    if (renameLock.current) return;
    renameLock.current = true;
    const next = renameValue.trim();
    if (next === "" || next === chat.name) {
      skipRename.current = true;
      setRenaming(false);
      renameLock.current = false;
      return;
    }
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(chat.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok || !isSummary(body)) {
        throw new Error(messageFrom(body, "The bot could not be renamed."));
      }
      setBots((list) =>
        list.map((bot) =>
          bot.id === body.id ? { ...bot, name: body.name } : bot,
        ),
      );
      setChat((current) =>
        current.id === body.id ? { ...current, name: body.name } : current,
      );
      skipRename.current = true;
      setRenaming(false);
      setShellError(undefined);
    } catch (error) {
      setShellError(
        error instanceof Error
          ? error.message
          : "The bot could not be renamed.",
      );
    } finally {
      renameLock.current = false;
    }
  }
}

function isLoadedBot(value: unknown): value is LoadedBot {
  if (typeof value !== "object" || value === null) return false;
  const bot = value as Partial<LoadedBot>;
  return (
    typeof bot.id === "string" &&
    typeof bot.name === "string" &&
    Array.isArray(bot.messages) &&
    typeof bot.resume === "boolean"
  );
}

function isSummary(value: unknown): value is BotSummary {
  if (typeof value !== "object" || value === null) return false;
  const bot = value as Partial<BotSummary>;
  return typeof bot.id === "string" && typeof bot.name === "string";
}

function messageFrom(value: unknown, fallback: string): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  ) {
    return value.error;
  }
  return fallback;
}
