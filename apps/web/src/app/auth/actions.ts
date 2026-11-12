"use server";

/**
 * Sign-in and sign-out for the page.
 * Google is the account anyone can use. The email form is only for local
 * development, where an agent can fill it. Both write the session cookie.
 */

import { createClient } from "@/lib/supabase/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export type SignInState = { error: string };

/**
 * Starts Google sign-in and sends the browser to the provider.
 * The callback at /auth/callback finishes the session.
 */
export async function signInWithGoogle(): Promise<void> {
  let supabase;
  try {
    supabase = await createClient();
  } catch {
    redirect("/?error=config");
  }
  const origin = await requestOrigin();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${origin}/auth/callback` },
  });
  if (error || data.url == null) redirect("/?error=google");
  redirect(data.url);
}

/**
 * Signs in with the email and password from the development form.
 * A production build refuses this. The message never echoes the password.
 */
export async function signInWithPassword(
  _previous: SignInState,
  formData: FormData,
): Promise<SignInState> {
  if (process.env.NODE_ENV !== "development") {
    return { error: "Sign in with Google." };
  }
  const email = textValue(formData.get("email"));
  const password = formData.get("password");
  if (email === null || typeof password !== "string" || password === "") {
    return { error: "Enter an email and a password." };
  }
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) return { error: "That email and password did not sign in." };
  } catch {
    return { error: "Sign-in is not configured." };
  }
  redirect("/");
}

/**
 * Signs this browser out and returns to the sign-in page.
 * Other browsers keep their own sessions.
 */
export async function signOut(): Promise<void> {
  try {
    const supabase = await createClient();
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // A missing project has no cookie to clear. The page still goes home.
  }
  redirect("/");
}

function textValue(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

async function requestOrigin(): Promise<string> {
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  const proto = headerStore.get("x-forwarded-proto") ?? "http";
  if (host == null || host === "") return "http://127.0.0.1:3000";
  return `${proto}://${host}`;
}
