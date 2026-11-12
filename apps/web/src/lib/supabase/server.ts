/**
 * The signed-in account for Server Components, Server Actions, and route handlers.
 * The session lives in cookies. Callers use getClaims, which checks the token,
 * and never the unverified session object.
 */
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import {
  e2eSessionOpen,
  readAccount,
  supabaseConfig,
  type Account,
} from "./gate";

export type { Account };

/**
 * A Supabase client bound to this request's cookies.
 * The proxy refreshes the session. A Server Component cannot write cookies,
 * so a failed write here is left to that proxy.
 */
export async function createClient() {
  const config = supabaseConfig();
  if (config === null) {
    throw new Error("Supabase is not configured.");
  }
  const cookieStore = await cookies();
  return createServerClient(config.url, config.key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // A Server Component cannot set cookies. The proxy already did.
        }
      },
    },
  });
}

/**
 * The account for this request, or null when nobody is signed in.
 * The chat harness without a Supabase project is treated as signed in so
 * those tests can reach the local daemon. A configured project never takes
 * that path.
 */
export async function currentAccount(): Promise<Account | null> {
  if (e2eSessionOpen()) return { id: "e2e", avatarUrl: null };
  if (supabaseConfig() === null) return null;
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getClaims();
    if (error != null || data?.claims == null) return null;
    return readAccount(data.claims);
  } catch {
    return null;
  }
}

/**
 * A 401 when this request has no account.
 * Route handlers call this before they talk to the daemon. The daemon
 * itself is not given a Supabase session.
 */
export async function refuseUnsigned(): Promise<Response | null> {
  const account = await currentAccount();
  if (account !== null) return null;
  return Response.json({ error: "Sign in to continue." }, { status: 401 });
}
