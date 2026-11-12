/**
 * Finishes Google sign-in. Supabase sends the browser back with a code,
 * and this route exchanges it for the cookie session, then opens the app.
 */
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (code) {
    try {
      const supabase = await createClient();
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) return NextResponse.redirect(new URL("/", url.origin));
    } catch {
      return NextResponse.redirect(new URL("/?error=config", url.origin));
    }
  }
  return NextResponse.redirect(new URL("/?error=google", url.origin));
}
