/**
 * Who may open the app before a session is checked.
 * The signed-in account is the Supabase user. Bots stay on this computer.
 */

export type Account = {
  id: string;
  avatarUrl: string | null;
};

/** What a request with no account may do. */
export type UnsignedAccess = "continue" | "landing" | "redirect" | "deny";

/**
 * The hosted project, when this process was given its public URL and key.
 * The publishable key is the one the browser and the server both use.
 */
export function supabaseConfig(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
  if (url === "" || key === "") return null;
  return { url, key };
}

/**
 * The scripted chat tests set COMPANION_E2E_SESSION so they can still open
 * the app when a build has no Supabase project. A build that has the keys
 * ignores the flag and requires a real session.
 */
export function e2eSessionOpen(): boolean {
  return process.env.COMPANION_E2E_SESSION === "1" && supabaseConfig() === null;
}

/**
 * What an unsigned request may do.
 * The app and its /api routes stay closed. The sign-in page and the OAuth
 * callback stay open so a person can arrive and finish Google sign-in.
 */
export function unsignedAccess(
  pathname: string,
  e2eOpen: boolean,
): UnsignedAccess {
  if (e2eOpen) return "continue";
  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  if (path.startsWith("/api")) return "deny";
  if (path.startsWith("/auth")) return "continue";
  if (path === "/") return "landing";
  return "redirect";
}

/**
 * The account a verified token names, including the picture when Google sent one.
 * Anything that is not a verified claim set is no account.
 */
export function readAccount(claims: unknown): Account | null {
  if (typeof claims !== "object" || claims === null || !("sub" in claims)) {
    return null;
  }
  const sub = claims.sub;
  if (typeof sub !== "string" || sub === "") return null;
  const metadata = "user_metadata" in claims ? claims.user_metadata : undefined;
  return { id: sub, avatarUrl: readAvatar(metadata) };
}

function readAvatar(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const record = metadata as Record<string, unknown>;
  for (const key of ["avatar_url", "picture"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}
