/**
 * Refreshes the cookie session and keeps an unsigned person out of the app.
 * Next.js 16 runs this from src/proxy.ts on each matched request.
 */
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  e2eSessionOpen,
  readAccount,
  supabaseConfig,
  unsignedAccess,
} from "./gate";

const cacheHeaders = ["cache-control", "expires", "pragma"] as const;

/**
 * The response for this request, with the session cookie refreshed when
 * Supabase issued a new one.
 */
export async function updateSession(
  request: NextRequest,
): Promise<NextResponse> {
  const config = supabaseConfig();
  if (config === null) {
    return decide(request, null, e2eSessionOpen());
  }

  let supabaseResponse = NextResponse.next({ request });
  const supabase = createServerClient(config.url, config.key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          supabaseResponse.cookies.set(name, value, options);
        });
        Object.entries(headers).forEach(([key, value]) => {
          supabaseResponse.headers.set(key, value);
        });
      },
    },
  });

  // getClaims checks the token. It has to run before any other session use,
  // or a refresh can be lost and the next request signs the person out.
  let signedIn = false;
  try {
    const { data, error } = await supabase.auth.getClaims();
    signedIn =
      error == null &&
      data?.claims != null &&
      readAccount(data.claims) !== null;
  } catch {
    signedIn = false;
  }
  if (signedIn) return supabaseResponse;
  return decide(request, supabaseResponse, false);
}

function decide(
  request: NextRequest,
  session: NextResponse | null,
  e2eOpen: boolean,
): NextResponse {
  const access = unsignedAccess(request.nextUrl.pathname, e2eOpen);
  switch (access) {
    case "continue":
    case "landing":
      return session ?? NextResponse.next({ request });
    case "redirect":
      return carry(session, redirectHome(request));
    case "deny":
      return carry(session, deny());
    default: {
      const unreachable: never = access;
      return unreachable;
    }
  }
}

function redirectHome(request: NextRequest): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = "/";
  url.search = "";
  return NextResponse.redirect(url);
}

function deny(): NextResponse {
  return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
}

/** Keeps a refreshed session on a response this proxy built itself. */
function carry(
  session: NextResponse | null,
  response: NextResponse,
): NextResponse {
  if (session === null) return response;
  for (const cookie of session.headers.getSetCookie()) {
    response.headers.append("set-cookie", cookie);
  }
  for (const header of cacheHeaders) {
    const value = session.headers.get(header);
    if (value) response.headers.set(header, value);
  }
  return response;
}
