/**
 * Proves the web server reaches the daemon the way its environment says:
 * straight to an address, or through the relay with a token for one VM.
 */
import { verifyToken } from "@companion/shared/tunnel";
import { afterEach, expect, test, vi } from "vitest";
import { daemonFetch } from "../src/lib/daemon";

/** The signed-in account the relay path reads; each test sets who it is. */
const signedIn = vi.hoisted(() => ({ id: "user-a" as string | null }));
vi.mock("../src/lib/supabase/server", () => ({
  currentAccount: async () =>
    signedIn.id === null ? null : { id: signedIn.id, avatarUrl: null },
}));

afterEach(() => {
  signedIn.id = "user-a";
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Replaces fetch and records the address and headers of each call. */
function fakeFetch() {
  const calls: Array<{ url: string; headers: Headers }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: new Headers(init?.headers) });
      return new Response("ok");
    }),
  );
  return calls;
}

const setEnv = (values: Record<string, string>) => {
  for (const name of [
    "COMPANION_DAEMON_URL",
    "COMPANION_RELAY_URL",
    "COMPANION_RELAY_SECRET",
  ]) {
    vi.stubEnv(name, values[name] ?? "");
  }
};

test("a local daemon is called directly with no token", async () => {
  const calls = fakeFetch();
  setEnv({ COMPANION_DAEMON_URL: "http://localhost:3010/" });
  await daemonFetch("/bots");
  expect(calls[0]?.url).toBe("http://localhost:3010/bots");
  expect(calls[0]?.headers.get("authorization")).toBeNull();
});

test("through the relay, a call carries a short token for the user's own VM", async () => {
  const calls = fakeFetch();
  const secret = "s".repeat(40);
  setEnv({
    COMPANION_RELAY_URL: "https://relay.example.com",
    COMPANION_RELAY_SECRET: secret,
  });
  await daemonFetch("/bots/a/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  expect(calls[0]?.url).toBe("https://relay.example.com/bots/a/messages");
  expect(calls[0]?.headers.get("content-type")).toBe("application/json");
  const bearer = calls[0]?.headers.get("authorization") ?? "";
  const claims = verifyToken(bearer.replace("Bearer ", ""), secret, "web");
  expect(claims.vm).toBe("user-a");
  expect(claims.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60);
});

test("each signed-in user reaches a different VM, and a caller may name one", async () => {
  const calls = fakeFetch();
  const secret = "s".repeat(40);
  setEnv({
    COMPANION_RELAY_URL: "https://relay.example.com",
    COMPANION_RELAY_SECRET: secret,
  });
  const vmOf = (call: number) =>
    verifyToken(
      (calls[call]?.headers.get("authorization") ?? "").replace("Bearer ", ""),
      secret,
      "web",
    ).vm;
  signedIn.id = "user-a";
  await daemonFetch("/bots");
  signedIn.id = "user-b";
  await daemonFetch("/bots");
  await daemonFetch("/bots", undefined, "user-c");
  expect([vmOf(0), vmOf(1), vmOf(2)]).toEqual(["user-a", "user-b", "user-c"]);
});

test("nobody signed in reaches no VM through the relay", async () => {
  const calls = fakeFetch();
  setEnv({
    COMPANION_RELAY_URL: "https://relay.example.com",
    COMPANION_RELAY_SECRET: "s".repeat(40),
  });
  signedIn.id = null;
  await expect(daemonFetch("/bots")).rejects.toThrow("Sign in");
  expect(calls).toHaveLength(0);
});

test("a mixed or incomplete setup is refused", async () => {
  fakeFetch();
  setEnv({
    COMPANION_DAEMON_URL: "http://localhost:3010",
    COMPANION_RELAY_URL: "https://relay.example.com",
  });
  await expect(daemonFetch("/bots")).rejects.toThrow("not both");
  setEnv({ COMPANION_RELAY_URL: "https://relay.example.com" });
  await expect(daemonFetch("/bots")).rejects.toThrow("COMPANION_RELAY_SECRET");
  setEnv({});
  await expect(daemonFetch("/bots")).rejects.toThrow("COMPANION_DAEMON_URL");
});
