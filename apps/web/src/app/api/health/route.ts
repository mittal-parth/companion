/**
 * Liveness check for the web process. The smoke test calls this and expects
 * `{ ok: true }`.
 */
export function GET() {
  return Response.json({ ok: true });
}
