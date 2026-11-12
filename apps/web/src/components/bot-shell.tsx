"use client";

/**
 * The sidebar of this computer's bots, and the conversation that is open.
 * A right-click on a row edits the name, changes the preset avatar, or
 * deletes the bot. Edit replaces the row's name with a text field: Enter or
 * leaving the field saves, and Escape keeps the previous name. The chat
 * header shows that same avatar and the name, beside the theme control.
 * Delete asks first, then removes the bot and its conversation. The next bot
 * opens, or the one above when the deleted bot was last in the list. The last
 * bot leaves a screen that asks for a picture and a name. A refresh opens the
 * first bot again, and an empty computer stays on that screen.
 */
import { AvatarPicker, BotAvatar } from "@/components/bot-avatar";
import { Chat } from "@/components/chat";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
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
import {
  defaultAvatar,
  parseAvatar,
  type BotAvatar as ChosenAvatar,
} from "@companion/shared/avatar";
import { PlusIcon } from "lucide-react";
import { useRef, useState } from "react";

export function BotShell({
  bots: initialBots,
  chat: initialChat,
}: {
  bots: BotSummary[];
  chat: LoadedBot | null;
}) {
  const [bots, setBots] = useState(initialBots);
  const [chat, setChat] = useState(initialChat);
  const [switching, setSwitching] = useState(false);
  const [shellError, setShellError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState(
    initialBots.length === 0 ? "New Bot" : "",
  );
  const [createAvatar, setCreateAvatar] = useState(defaultAvatar);
  const [createError, setCreateError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [avatarEdit, setAvatarEdit] = useState<BotSummary>();
  const [avatarDraft, setAvatarDraft] = useState(defaultAvatar);
  const [avatarError, setAvatarError] = useState<string>();
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [renameValue, setRenameValue] = useState("");
  const [pendingDelete, setPendingDelete] = useState<BotSummary>();
  const [deleteError, setDeleteError] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const createNameRef = useRef<HTMLInputElement>(null);
  const renameLock = useRef(false);
  // Bumped when an edit starts or is dropped, so a late blur cannot save it.
  const renameGeneration = useRef(0);
  const renameSession = renameGeneration.current;

  return (
    <SidebarProvider className="h-svh">
      <Sidebar>
        <SidebarHeader className="flex-row items-center justify-between">
          <span className="px-2 text-sm font-medium">Bots</span>
          <Button
            aria-label="New bot"
            onClick={() => {
              setCreateError(undefined);
              if (bots.length === 0) {
                createNameRef.current?.focus();
                return;
              }
              setCreateName("");
              setCreateAvatar(defaultAvatar);
              setCreateOpen(true);
            }}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <PlusIcon />
          </Button>
        </SidebarHeader>
        <SidebarContent className="flex flex-col">
          <SidebarGroup>
            <SidebarGroupContent>
              {bots.length === 0 ? (
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      className="h-auto min-h-16 gap-3 overflow-visible px-3 py-3 text-base font-medium"
                      isActive
                      onClick={() => createNameRef.current?.focus()}
                      type="button"
                    >
                      <BotAvatar avatar={createAvatar} size={40} />
                      <span className="truncate">Create your first Bot</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              ) : (
                <SidebarMenu className="gap-1.5">
                  {bots.map((bot) => (
                    <SidebarMenuItem key={bot.id}>
                      {editingId === bot.id ? (
                        <form
                          onSubmit={(event) => {
                            event.preventDefault();
                            void saveRename(renameSession, bot.id);
                          }}
                        >
                          <input
                            aria-label="Bot name"
                            autoComplete="off"
                            autoFocus
                            className="h-16 w-full min-w-0 rounded-md border border-sidebar-border bg-background px-3 text-base text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                            onBlur={() =>
                              void saveRename(renameSession, bot.id)
                            }
                            onChange={(event) =>
                              setRenameValue(event.target.value)
                            }
                            onFocus={(event) => event.currentTarget.select()}
                            onKeyDown={(event) => {
                              if (event.key !== "Escape") return;
                              event.preventDefault();
                              renameGeneration.current += 1;
                              setEditingId(undefined);
                            }}
                            spellCheck={false}
                            value={renameValue}
                          />
                        </form>
                      ) : (
                        <ContextMenu>
                          <ContextMenuTrigger asChild>
                            <SidebarMenuButton
                              className="h-auto min-h-16 gap-3 overflow-visible px-3 py-3 text-base font-medium"
                              isActive={bot.id === chat?.id}
                              onClick={() => void openBot(bot.id)}
                              type="button"
                            >
                              <BotAvatar avatar={bot.avatar} size={40} />
                              <span className="truncate">{bot.name}</span>
                            </SidebarMenuButton>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem onSelect={() => beginEdit(bot)}>
                              Edit
                            </ContextMenuItem>
                            <ContextMenuItem
                              onSelect={() => {
                                setAvatarError(undefined);
                                setAvatarDraft(bot.avatar);
                                setAvatarEdit(bot);
                              }}
                            >
                              Change avatar
                            </ContextMenuItem>
                            <ContextMenuItem
                              onSelect={() => {
                                setDeleteError(undefined);
                                setPendingDelete(bot);
                              }}
                              variant="destructive"
                            >
                              Delete
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      )}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
          {bots.length === 0 ? (
            <p className="flex flex-1 items-center justify-center px-4 text-sm text-sidebar-foreground/70">
              No chats yet
            </p>
          ) : null}
        </SidebarContent>
      </Sidebar>
      <SidebarInset className="min-h-0 overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2">
          <SidebarTrigger />
          {chat !== null ? (
            <BotTitle avatar={chat.avatar} name={chat.name} />
          ) : bots.length === 0 ? (
            <BotTitle
              avatar={createAvatar}
              name={createName.trim() === "" ? "New Bot" : createName.trim()}
            />
          ) : (
            <div className="flex-1" />
          )}
          <ThemeToggle className="shrink-0" />
        </header>
        {shellError ? (
          <p className="px-4 pt-2 text-destructive text-sm" role="alert">
            {shellError}
          </p>
        ) : null}
        {chat !== null ? (
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
        ) : bots.length === 0 ? (
          <main className="flex flex-1 items-center justify-center p-8">
            <form
              className="flex w-full max-w-xl flex-col items-center"
              onSubmit={(event) => {
                event.preventDefault();
                void createBot();
              }}
            >
              <AvatarPicker
                avatar={createAvatar}
                disabled={creating}
                onChange={setCreateAvatar}
              />
              <div className="mt-6 w-full">
                <label
                  className="text-sm text-muted-foreground"
                  htmlFor="new-bot-name"
                >
                  Name
                </label>
                <Input
                  autoComplete="off"
                  autoFocus
                  className="mt-2"
                  disabled={creating}
                  id="new-bot-name"
                  onChange={(event) => setCreateName(event.target.value)}
                  ref={createNameRef}
                  value={createName}
                />
              </div>
              {createError ? (
                <p className="pt-2 text-destructive text-sm" role="alert">
                  {createError}
                </p>
              ) : null}
              <Button
                className="mt-6"
                disabled={creating || createName.trim() === ""}
                type="submit"
                variant="secondary"
              >
                {creating ? "Creating" : "Get started"}
              </Button>
            </form>
          </main>
        ) : (
          <main className="flex flex-1 items-center justify-center p-8">
            <p className="text-muted-foreground">Choose a bot.</p>
          </main>
        )}
      </SidebarInset>
      <Dialog open={createOpen} onOpenChange={closeCreate}>
        <DialogContent className="p-6 sm:max-w-xl">
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
            <AvatarPicker
              avatar={createAvatar}
              disabled={creating}
              onChange={setCreateAvatar}
              previewSize={112}
            />
            <Input
              aria-label="Name"
              autoComplete="off"
              autoFocus
              className="mt-4"
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
      <Dialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (open || deleting) return;
          setPendingDelete(undefined);
          setDeleteError(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {pendingDelete?.name ?? "this bot"}?
            </DialogTitle>
            <DialogDescription>
              This deletes the bot and its conversation.
            </DialogDescription>
          </DialogHeader>
          {deleteError ? (
            <p className="text-destructive text-sm" role="alert">
              {deleteError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={deleting}
              onClick={() => {
                setPendingDelete(undefined);
                setDeleteError(undefined);
              }}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={deleting || pendingDelete === undefined}
              onClick={() => void confirmDelete()}
              type="button"
              variant="destructive"
            >
              {deleting ? "Deleting" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={avatarEdit !== undefined}
        onOpenChange={(open) => {
          if (open || savingAvatar) return;
          setAvatarEdit(undefined);
          setAvatarError(undefined);
        }}
      >
        <DialogContent className="p-6 sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Change avatar</DialogTitle>
            <DialogDescription>
              Pick a color and a shape. The conversation stays the same.
            </DialogDescription>
          </DialogHeader>
          <AvatarPicker
            avatar={avatarDraft}
            disabled={savingAvatar}
            onChange={setAvatarDraft}
            previewSize={112}
          />
          {avatarError ? (
            <p className="text-destructive text-sm" role="alert">
              {avatarError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={savingAvatar}
              onClick={() => {
                setAvatarEdit(undefined);
                setAvatarError(undefined);
              }}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={savingAvatar || avatarEdit === undefined}
              onClick={() => void saveAvatar()}
              type="button"
            >
              {savingAvatar ? "Saving" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );

  function closeCreate(open: boolean) {
    if (!open && creating) return;
    setCreateOpen(open);
    if (!open) {
      setCreateName("");
      setCreateAvatar(defaultAvatar);
      setCreateError(undefined);
    }
  }

  function beginEdit(bot: BotSummary) {
    renameGeneration.current += 1;
    setRenameValue(bot.name);
    setEditingId(bot.id);
    setShellError(undefined);
  }

  async function openBot(id: string): Promise<boolean> {
    if (switching || id === chat?.id) return id === chat?.id;
    setSwitching(true);
    setShellError(undefined);
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(id)}`);
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok || !isLoadedBot(body)) {
        throw new Error(messageFrom(body, "The bot could not be opened."));
      }
      setChat(body);
      return true;
    } catch (error) {
      setShellError(
        error instanceof Error ? error.message : "The bot could not be opened.",
      );
      return false;
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
        body: JSON.stringify({
          name,
          shape: createAvatar.shape,
          color: createAvatar.color,
        }),
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok || !isLoadedBot(body)) {
        throw new Error(messageFrom(body, "The bot could not be created."));
      }
      setBots((list) => [
        ...list,
        { id: body.id, name: body.name, avatar: body.avatar },
      ]);
      setChat(body);
      setCreateName("");
      setCreateAvatar(defaultAvatar);
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

  async function saveRename(generation: number, botId: string) {
    if (generation !== renameGeneration.current || renameLock.current) return;
    renameLock.current = true;
    const currentName = bots.find((bot) => bot.id === botId)?.name;
    const next = renameValue.trim();
    if (currentName === undefined || next === "" || next === currentName) {
      renameGeneration.current += 1;
      setEditingId((id) => (id === botId ? undefined : id));
      renameLock.current = false;
      return;
    }
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(botId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (generation !== renameGeneration.current) return;
      if (!response.ok || !isSummary(body)) {
        throw new Error(messageFrom(body, "The bot could not be renamed."));
      }
      setBots((list) =>
        list.map((bot) =>
          bot.id === body.id ? { ...bot, name: body.name } : bot,
        ),
      );
      setChat((current) =>
        current?.id === body.id ? { ...current, name: body.name } : current,
      );
      renameGeneration.current += 1;
      setEditingId((id) => (id === botId ? undefined : id));
      setShellError(undefined);
    } catch (error) {
      if (generation !== renameGeneration.current) return;
      setShellError(
        error instanceof Error
          ? error.message
          : "The bot could not be renamed.",
      );
    } finally {
      renameLock.current = false;
    }
  }

  async function confirmDelete() {
    const target = pendingDelete;
    if (target === undefined || deleting) return;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      const response = await fetch(
        `/api/bots/${encodeURIComponent(target.id)}`,
        { method: "DELETE" },
      );
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok || !isDeleted(body)) {
        throw new Error(messageFrom(body, "The bot could not be deleted."));
      }
      const index = bots.findIndex((bot) => bot.id === target.id);
      const next = index < 0 ? undefined : (bots[index + 1] ?? bots[index - 1]);
      const wasOpen = chat?.id === target.id;
      if (editingId === target.id) {
        renameGeneration.current += 1;
        setEditingId(undefined);
      }
      const remaining = bots.filter((bot) => bot.id !== target.id);
      setBots(remaining);
      if (remaining.length === 0) {
        setCreateName("New Bot");
        setCreateAvatar(defaultAvatar);
      }
      setPendingDelete(undefined);
      if (!wasOpen) return;
      if (next !== undefined && next.id !== target.id) {
        const opened = await openBot(next.id);
        if (!opened) {
          setChat((current) => (current?.id === target.id ? null : current));
        }
        return;
      }
      setChat((current) => (current?.id === target.id ? null : current));
    } catch (error) {
      setDeleteError(
        error instanceof Error
          ? error.message
          : "The bot could not be deleted.",
      );
    } finally {
      setDeleting(false);
    }
  }

  async function saveAvatar() {
    const target = avatarEdit;
    if (target === undefined || savingAvatar) return;
    if (
      target.avatar.shape === avatarDraft.shape &&
      target.avatar.color === avatarDraft.color
    ) {
      setAvatarEdit(undefined);
      return;
    }
    setSavingAvatar(true);
    setAvatarError(undefined);
    try {
      const response = await fetch(
        `/api/bots/${encodeURIComponent(target.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            shape: avatarDraft.shape,
            color: avatarDraft.color,
          }),
        },
      );
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok || !isAvatarUpdate(body)) {
        throw new Error(messageFrom(body, "The avatar could not be changed."));
      }
      setBots((list) =>
        list.map((bot) =>
          bot.id === body.id ? { ...bot, avatar: body.avatar } : bot,
        ),
      );
      setChat((current) =>
        current?.id === body.id ? { ...current, avatar: body.avatar } : current,
      );
      setAvatarEdit(undefined);
    } catch (error) {
      setAvatarError(
        error instanceof Error
          ? error.message
          : "The avatar could not be changed.",
      );
    } finally {
      setSavingAvatar(false);
    }
  }
}

/** The picture and name in the chat header. The picture is decorative. */
function BotTitle({ avatar, name }: { avatar: ChosenAvatar; name: string }) {
  return (
    <h1 className="flex min-w-0 flex-1 items-center gap-2.5 px-2 text-base font-medium">
      <BotAvatar avatar={avatar} size={28} />
      <span className="truncate">{name}</span>
    </h1>
  );
}

function isLoadedBot(value: unknown): value is LoadedBot {
  if (typeof value !== "object" || value === null) return false;
  const bot = value as Partial<LoadedBot>;
  return (
    typeof bot.id === "string" &&
    typeof bot.name === "string" &&
    isAvatar(bot.avatar) &&
    Array.isArray(bot.messages) &&
    typeof bot.resume === "boolean"
  );
}

function isAvatar(value: unknown): value is ChosenAvatar {
  if (typeof value !== "object" || value === null) return false;
  const avatar = value as Partial<ChosenAvatar>;
  return (
    typeof avatar.shape === "string" &&
    typeof avatar.color === "string" &&
    parseAvatar(avatar.shape, avatar.color) !== undefined
  );
}

function isAvatarUpdate(
  value: unknown,
): value is { id: string; avatar: ChosenAvatar } {
  if (typeof value !== "object" || value === null) return false;
  const bot = value as { id?: unknown; avatar?: unknown };
  return typeof bot.id === "string" && isAvatar(bot.avatar);
}

function isSummary(value: unknown): value is BotSummary {
  if (typeof value !== "object" || value === null) return false;
  const bot = value as Partial<BotSummary>;
  return typeof bot.id === "string" && typeof bot.name === "string";
}

function isDeleted(value: unknown): value is { deleted: string } {
  if (typeof value !== "object" || value === null || !("deleted" in value)) {
    return false;
  }
  return typeof value.deleted === "string";
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
