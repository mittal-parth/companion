/**
 * Who can open the app before a session exists.
 * An unsigned person gets the sign-in page. The app and its API stay closed.
 */
import { expect, test } from "vitest";
import { readAccount, unsignedAccess } from "../src/lib/supabase/gate";

test("an unsigned API call is refused", () => {
  expect(unsignedAccess("/api/health", false)).toBe("deny");
  expect(unsignedAccess("/api/bots/abc", false)).toBe("deny");
  expect(unsignedAccess("/api/chat", false)).toBe("deny");
});

test("an unsigned person gets the sign-in page", () => {
  expect(unsignedAccess("/", false)).toBe("landing");
  expect(unsignedAccess("/bots/abc", false)).toBe("redirect");
  expect(unsignedAccess("/auth/callback", false)).toBe("continue");
});

test("the chat harness stays open only when it is marked open", () => {
  expect(unsignedAccess("/api/health", true)).toBe("continue");
  expect(unsignedAccess("/", true)).toBe("continue");
  expect(unsignedAccess("/bots/abc", true)).toBe("continue");
});

test("a verified claim set is the account, and the picture is optional", () => {
  expect(readAccount(null)).toBeNull();
  expect(readAccount({ sub: "" })).toBeNull();
  expect(readAccount({ sub: "user-1" })).toEqual({
    id: "user-1",
    avatarUrl: null,
  });
  expect(
    readAccount({
      sub: "user-1",
      user_metadata: { avatar_url: "https://example.com/a.png" },
    }),
  ).toEqual({ id: "user-1", avatarUrl: "https://example.com/a.png" });
  expect(
    readAccount({
      sub: "user-1",
      user_metadata: { picture: "https://example.com/b.png" },
    }),
  ).toEqual({ id: "user-1", avatarUrl: "https://example.com/b.png" });
});
