// Times the host agent's computers through the real relay and a real EBS volume.
//   measure.mjs provision <user>   create a volume, start a computer, wait until it answers
//   measure.mjs sleep <user>       stop it and wait until its volume is detached
//   measure.mjs wake <user> [n]    start it again, n times with a sleep between
// Needs RELAY_SECRET and AWS_PROFILE/AWS_REGION in the environment; prints no secret.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { signToken } from "../../../packages/shared/src/tunnel.ts";

const RELAY = "https://companion-relay.mittalparth.dev";
const AZ = "ap-south-1a";
const STATE = new URL("./.state.json", import.meta.url).pathname;
const secret = process.env.RELAY_SECRET.trim();
const aws = (...a) =>
  JSON.parse(
    execFileSync("aws", [...a, "--output", "json"], { encoding: "utf8" }) ||
      "null",
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const s = (t0) => `${((now() - t0) / 1000).toFixed(2)} s`;
const tok = (role, vm) =>
  signToken({ role, vm, exp: Math.floor(Date.now() / 1000) + 7200 }, secret);
const state = () =>
  existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = (u, v) =>
  writeFileSync(STATE, JSON.stringify({ ...state(), [u]: v }, null, 2));
const call = (vm, method, path, body) =>
  fetch(`${RELAY}${path}`, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      authorization: `Bearer ${tok("web", vm)}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

async function healthy(user, t0, limit = 240000) {
  while (now() - t0 < limit) {
    try {
      if ((await call(user, "GET", `/health?t=${Date.now()}`)).status === 200)
        return s(t0);
    } catch {}
    await sleep(100);
  }
  return "timeout";
}
async function start(user, volumeId) {
  const r = await call("host-1", "POST", "/computers", {
    userId: user,
    volumeId,
    relayUrl: RELAY.replace("https", "wss"),
    relayToken: tok("vm", user),
  });
  return `${r.status} ${(await r.text()).slice(0, 120)}`;
}
async function detached(volumeId, t0) {
  for (;;) {
    const v = aws("ec2", "describe-volumes", "--volume-ids", volumeId)
      .Volumes[0];
    if (v.State === "available") return s(t0);
    await sleep(500);
  }
}

const [cmd, user, n = "1"] = process.argv.slice(2);
if (cmd === "provision") {
  let t0 = now();
  const v = aws(
    "ec2",
    "create-volume",
    "--availability-zone",
    AZ,
    "--size",
    "20",
    "--volume-type",
    "gp3",
    "--encrypted",
    "--tag-specifications",
    `ResourceType=volume,Tags=[{Key=companion:managed,Value=true},{Key=owner,Value=${user}}]`,
  );
  const volumeId = v.VolumeId;
  while (
    aws("ec2", "describe-volumes", "--volume-ids", volumeId).Volumes[0]
      .State !== "available"
  )
    await sleep(300);
  console.log(`volume ${volumeId} created and available after ${s(t0)}`);
  save(user, { volumeId });
  t0 = now();
  console.log(
    `start: ${await start(user, volumeId)} (post answered after ${s(t0)})`,
  );
  console.log(
    `daemon answering through the relay after ${await healthy(user, t0)} (from the start request)`,
  );
} else if (cmd === "sleep") {
  const t0 = now();
  const r = await call("host-1", "DELETE", `/computers/${user}`);
  console.log(`delete: ${r.status} after ${s(t0)}`);
  console.log(
    `volume detached after ${await detached(state()[user].volumeId, t0)}`,
  );
} else if (cmd === "wake") {
  for (let i = 1; i <= Number(n); i++) {
    const t0 = now();
    console.log(
      `wake ${i}: start ${await start(user, state()[user].volumeId)} after ${s(t0)}; daemon after ${await healthy(user, t0)}`,
    );
    if (i < Number(n)) {
      await call("host-1", "DELETE", `/computers/${user}`);
      await detached(state()[user].volumeId, now());
    }
  }
} else throw new Error("unknown command");
