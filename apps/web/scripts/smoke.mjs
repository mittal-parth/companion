/**
 * Confirms the built app is serving the sign-in page, and that an unsigned
 * caller cannot use the health route. `start-server-and-test` runs this
 * after `next start` is accepting connections.
 */
const base = process.env.SMOKE_URL ?? "http://127.0.0.1:3010";

const home = await fetch(`${base}/`);
if (!home.ok) {
  throw new Error(`Home returned ${home.status}`);
}
const html = await home.text();
if (!html.includes("Companion") || !html.includes("Sign in with Google")) {
  throw new Error("Home page did not include the sign-in page");
}
if (html.includes("sign-in-email")) {
  throw new Error("The production page included the development sign-in form");
}

const health = await fetch(`${base}/api/health`);
if (health.status !== 401) {
  throw new Error(`Health returned ${health.status}`);
}
