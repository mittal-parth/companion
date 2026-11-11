/**
 * A small fake website for browser tests and the browser CLI comparison.
 *
 * It has a search page, a booking form with a validation error, a page of
 * awkward elements (a new tab, an iframe, a dialog, a late button) and a login
 * that sets a cookie. Every code a page shows is derived from a random seed, so
 * a model cannot guess it and can only report it after really reading the page.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";

/** A running fake site. */
export type FixtureSite = {
  url: string;
  /** The code the booking confirmation shows for these answers. */
  bookingCode(item: number, name: string, plan: string): string;
  /** The four codes the awkward page hides behind its obstacles. */
  awkwardCodes: { newTab: string; frame: string; dialog: string; late: string };
  /** The code the account page shows once someone is signed in. */
  accountCode(user: string): string;
  /** Every request path the site received, in order. */
  requests: string[];
  stop(): Promise<void>;
};

/** What the search page lists. The second result is the one with the form. */
const items = [
  { id: 1, title: "Birch Hostel", blurb: "Shared rooms near the station." },
  { id: 2, title: "Pine Cottage", blurb: "A quiet cottage with a garden." },
  { id: 3, title: "Cedar Lodge", blurb: "Large rooms with a lake view." },
];

/** Starts the site on a free local port. */
export async function startFixtureSite(): Promise<FixtureSite> {
  const seed = randomUUID();
  const requests: string[] = [];
  const code = (prefix: string, ...parts: string[]) =>
    `${prefix}-${createHash("sha256")
      .update([seed, prefix, ...parts].join("|"))
      .digest("hex")
      .slice(0, 8)
      .toUpperCase()}`;
  const awkwardCodes = {
    newTab: code("TAB"),
    frame: code("FRAME"),
    dialog: code("DIALOG"),
    late: code("LATE"),
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      requests.push(`${req.method ?? "GET"} ${url.pathname}`);
      const send = (status: number, body: string, headers = {}) => {
        res.writeHead(status, { "content-type": "text/html", ...headers });
        res.end(page(body));
      };
      const path = url.pathname;

      if (path === "/") {
        send(
          200,
          `<h1>Fixture site</h1>
<form action="/search"><label>Search <input name="q"></label> <button>Go</button></form>
<p><a href="/awkward">Awkward page</a> <a href="/login">Sign in</a></p>`,
        );
        return;
      }
      if (path === "/search") {
        const query = url.searchParams.get("q") ?? "";
        send(
          200,
          `<h1>Results for ${escapeHtml(query)}</h1><ol>${items
            .map(
              (item) =>
                `<li><a href="/items/${item.id}">${item.title}</a> - ${item.blurb}</li>`,
            )
            .join("")}</ol>`,
        );
        return;
      }
      const itemPage = /^\/items\/(\d+)$/.exec(path);
      if (itemPage !== null) {
        const item = items.find((entry) => entry.id === Number(itemPage[1]));
        if (item === undefined) {
          send(404, "<h1>Not found</h1>");
          return;
        }
        send(200, bookingForm(item, "", new URLSearchParams()));
        return;
      }
      const booking = /^\/items\/(\d+)\/book$/.exec(path);
      if (booking !== null && req.method === "POST") {
        const item = items.find((entry) => entry.id === Number(booking[1]));
        const form = await readForm(req);
        if (item === undefined) {
          send(404, "<h1>Not found</h1>");
          return;
        }
        const name = form.get("name") ?? "";
        const plan = form.get("plan") ?? "";
        if (form.get("terms") !== "yes") {
          send(
            200,
            bookingForm(
              item,
              `<p role="alert">Please accept the terms before sending.</p>`,
              form,
            ),
          );
          return;
        }
        send(
          200,
          `<h1>Booking confirmed</h1><p>Confirmation code: <strong>${code(
            "BK",
            String(item.id),
            name,
            plan,
          )}</strong></p>`,
        );
        return;
      }
      if (path === "/awkward") {
        send(200, awkwardPage());
        return;
      }
      if (path === "/awkward/report") {
        send(
          200,
          `<h1>Report</h1><p>Report code: <strong>${awkwardCodes.newTab}</strong></p>`,
        );
        return;
      }
      if (path === "/awkward/frame") {
        send(
          200,
          `<form><label>Frame answer <input name="answer"></label>
<button type="button" onclick="document.getElementById('out').textContent='Frame code: ${awkwardCodes.frame}'">Check answer</button></form>
<p id="out"></p>`,
        );
        return;
      }
      if (path === "/login") {
        if (req.method === "POST") {
          const form = await readForm(req);
          const user = form.get("user") ?? "guest";
          const attributes =
            url.searchParams.get("session") === "1"
              ? "Path=/; HttpOnly"
              : "Path=/; HttpOnly; Max-Age=3600";
          res.writeHead(303, {
            location: "/account",
            "set-cookie": `fixture_user=${encodeURIComponent(user)}; ${attributes}`,
          });
          res.end();
          return;
        }
        send(
          200,
          `<h1>Sign in</h1><form method="post" action="/login${
            url.searchParams.get("session") === "1" ? "?session=1" : ""
          }">
<label>User <input name="user"></label>
<label>Password <input name="password" type="password"></label>
<button>Sign in</button></form>`,
        );
        return;
      }
      if (path === "/account") {
        const user = cookieValue(req, "fixture_user");
        if (user === undefined) {
          res.writeHead(303, { location: "/login" });
          res.end();
          return;
        }
        send(
          200,
          `<h1>Account</h1><p>Signed in as ${escapeHtml(user)}</p><p>Account code: <strong>${code(
            "AC",
            user,
          )}</strong></p>`,
        );
        return;
      }
      send(404, "<h1>Not found</h1>");
    })().catch(() => {
      res.destroy();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The fixture site did not bind a port.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    bookingCode: (item, name, plan) => code("BK", String(item), name, plan),
    awkwardCodes,
    accountCode: (user) => code("AC", user),
    requests,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };

  function awkwardPage(): string {
    return `<h1>Awkward page</h1>
<p><a href="/awkward/report" target="_blank">Open the report</a></p>
<iframe src="/awkward/frame" title="Question frame" width="400" height="140"></iframe>
<p><button id="reveal" onclick="if (confirm('Reveal the dialog code?')) document.getElementById('dialog-out').textContent='Dialog code: ${awkwardCodes.dialog}'">Reveal dialog code</button></p>
<p id="dialog-out"></p>
<div id="late"></div>
<script>
setTimeout(() => {
  const button = document.createElement('button');
  button.textContent = 'Late button';
  button.onclick = () => { document.getElementById('late').textContent = 'Late code: ${awkwardCodes.late}'; };
  document.getElementById('late').appendChild(button);
}, 2000);
</script>`;
  }
}

/** The booking form. `entered` refills it after a rejected submit, as real forms do. */
function bookingForm(
  item: { id: number; title: string },
  notice: string,
  entered: URLSearchParams,
): string {
  const value = (name: string) => escapeHtml(entered.get(name) ?? "");
  const option = (plan: string, label: string) =>
    `<option value="${plan}"${entered.get("plan") === plan ? " selected" : ""}>${label}</option>`;
  return `<h1>${item.title}</h1>
${notice}
<form method="post" action="/items/${item.id}/book">
<p><label>Full name <input name="name" value="${value("name")}" required></label></p>
<p><label>Email <input name="email" type="email" value="${value("email")}"></label></p>
<p><label>Plan <select name="plan">${option("basic", "Basic")}${option("standard", "Standard")}${option("premium", "Premium")}</select></label></p>
<p><label>Start date <input name="date" type="date" value="${value("date")}"></label></p>
<p><label><input name="terms" type="checkbox" value="yes"> I accept the terms</label></p>
<p><button>Send booking</button></p>
</form>`;
}

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title></head><body>${body}</body></html>`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] ?? char,
  );
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}
