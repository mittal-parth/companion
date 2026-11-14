/**
 * Proves the web server reaches the daemon the way its environment says:
 * straight to an address, or through the relay with a token for one VM.
 */
import { verifyToken } from "@companion/shared/tunnel";
import { afterEach, expect, test, vi } from "vitest";
import { daemonFetch } from "../src/lib/daemon";

afterEach(() => {
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
    "COMPANION_RELAY_VM",
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

test("through the relay, a call carries a short token for the VM", async () => {
  const calls = fakeFetch();
  const secret = "s".repeat(40);
  setEnv({
    COMPANION_RELAY_URL: "https://relay.example.com",
    COMPANION_RELAY_VM: "vm-1",
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
  expect(claims.vm).toBe("vm-1");
  expect(claims.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60);
});

test("a mixed or incomplete setup is refused", () => {
  fakeFetch();
  setEnv({
    COMPANION_DAEMON_URL: "http://localhost:3010",
    COMPANION_RELAY_URL: "https://relay.example.com",
  });
  expect(() => daemonFetch("/bots")).toThrow("not both");
  setEnv({ COMPANION_RELAY_URL: "https://relay.example.com" });
  expect(() => daemonFetch("/bots")).toThrow("COMPANION_RELAY_VM");
  setEnv({});
  expect(() => daemonFetch("/bots")).toThrow("COMPANION_DAEMON_URL");
});
