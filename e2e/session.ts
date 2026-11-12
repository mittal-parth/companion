/**
 * A cookie session for the dev account, for the browser tests.
 * The built app hides the email form, so those tests sign in through the
 * same password grant and store the cookie the server session reads.
 */
import { createServerClient, type CookieOptions } from "@supabase/ssr";

type StoredCookie = {
  name: string;
  value: string;
  options: CookieOptions;
};

/**
 * The dev account's session cookies, ready for the browser on 127.0.0.1.
 * The names of the variables are the only thing this reports when one is missing.
 */
export async function devSessionCookies(): Promise<
  {
    name: string;
    value: string;
    domain: string;
    path: string;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
    expires: number;
  }[]
> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
  const email = process.env.BINDU_DEV_EMAIL ?? "";
  const password = process.env.BINDU_DEV_PASS ?? "";
  if (url === "" || key === "" || email === "" || password === "") {
    throw new Error(
      "The dev sign-in needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, BINDU_DEV_EMAIL, and BINDU_DEV_PASS.",
    );
  }

  const jar: StoredCookie[] = [];
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return jar.map(({ name, value }) => ({ name, value }));
      },
      setAll(cookiesToSet) {
        for (const cookie of cookiesToSet) {
          const index = jar.findIndex((item) => item.name === cookie.name);
          if (index === -1) jar.push(cookie);
          else jar[index] = cookie;
        }
      },
    },
  });
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error || data.session == null || jar.length === 0) {
    throw new Error("The dev account did not sign in.");
  }

  return jar.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: "127.0.0.1",
    path: cookie.options.path ?? "/",
    httpOnly: cookie.options.httpOnly ?? false,
    // The browser tests use http. The server reads the cookie either way.
    secure: false,
    sameSite: sameSite(cookie.options.sameSite),
    expires: expires(cookie.options.maxAge),
  }));
}

function sameSite(value: CookieOptions["sameSite"]): "Strict" | "Lax" | "None" {
  if (value === "strict" || value === true) return "Strict";
  if (value === "none") return "None";
  return "Lax";
}

function expires(maxAge: number | undefined): number {
  if (maxAge == null) return -1;
  return Math.floor(Date.now() / 1000) + maxAge;
}
