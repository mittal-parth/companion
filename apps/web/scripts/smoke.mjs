/**
 * Confirms the built app is serving the home page and the health route.
 * `start-server-and-test` runs this after `next start` is accepting connections.
 */
const base = process.env.SMOKE_URL ?? "http://127.0.0.1:3010";

const home = await fetch(`${base}/`);
if (!home.ok) {
  throw new Error(`Home returned ${home.status}`);
}
const html = await home.text();
if (!html.includes("Companion")) {
  throw new Error("Home page did not include Companion");
}

const health = await fetch(`${base}/api/health`);
if (!health.ok) {
  throw new Error(`Health returned ${health.status}`);
}
const body = await health.json();
if (body.ok !== true) {
  throw new Error(`Health body was ${JSON.stringify(body)}`);
}
