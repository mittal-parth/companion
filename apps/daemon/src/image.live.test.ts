/**
 * Proves a pasted image is read by the vision subagent, not by GLM 5.3.
 * The code exists only as pixels. The live turn is skipped unless COMPANION_LIVE=1.
 */
import { deflateSync, inflateSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { BotView, TurnEvent } from "@companion/shared";
import { expect, test } from "vitest";
import { replyText } from "./acp-hello.js";
import { startDaemon } from "./api.js";
import { visionAgentId } from "./engine.js";

const opencodeBin = process.env.OPENCODE_BIN ?? "opencode";
const live = process.env.COMPANION_LIVE === "1";

const glyphs: Record<string, string[]> = {
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "4": ["00100", "01000", "10000", "10010", "11111", "00010", "00010"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  M: ["10001", "11011", "10101", "10001", "10001", "10001", "10001"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
};

/** A PNG whose only copy of `code` is the painted letters. */
export function codeImage(code: string): Buffer {
  const scale = 14;
  const gap = 10;
  const pad = 28;
  const glyphWidth = 5 * scale;
  const width = pad * 2 + code.length * glyphWidth + (code.length - 1) * gap;
  const height = pad * 2 + 7 * scale;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3, 255);
    // A PNG scanline starts with filter 0 (none). Filling the row must not set that byte.
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      if (!ink(code, x, y, scale, gap, pad)) continue;
      const start = 1 + x * 3;
      row[start] = 0;
      row[start + 1] = 0;
      row[start + 2] = 0;
    }
    rows.push(row);
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function ink(
  code: string,
  x: number,
  y: number,
  scale: number,
  gap: number,
  pad: number,
): boolean {
  if (x < pad || y < pad) return false;
  const glyphWidth = 5 * scale;
  const slot = glyphWidth + gap;
  const index = Math.floor((x - pad) / slot);
  const glyph = glyphs[code[index] ?? ""];
  if (glyph === undefined) return false;
  const column = x - pad - index * slot;
  if (column >= glyphWidth) return false;
  const row = y - pad;
  if (row >= 7 * scale) return false;
  return glyph[Math.floor(row / scale)]?.[Math.floor(column / scale)] === "1";
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, sum]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Filter byte of each scanline. A decoder rejects anything outside 0–4. */
function scanlineFilters(png: Buffer): number[] {
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    }
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = 1 + width * 3;
  return Array.from({ length: height }, (_, y) => raw[y * stride] ?? -1);
}

const fontFile = [
  "/usr/share/fonts/truetype/croscore/Arimo-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
].find((path) => existsSync(path));

/** A PNG of `code` drawn in a normal font. The letters are pixels, not text in the file. */
export function paintedImage(code: string): Buffer {
  if (fontFile === undefined) {
    throw new Error("No font available to paint the code.");
  }
  const file = join(tmpdir(), `companion-code-${process.pid}.png`);
  const draw = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=white:s=960x320",
      "-vf",
      `drawtext=fontfile=${fontFile}:text=${code}:fontsize=160:fontcolor=black:x=(w-text_w)/2:y=(h-text_h)/2`,
      "-frames:v",
      "1",
      "-update",
      "1",
      file,
    ],
    { encoding: "utf8" },
  );
  if (draw.status !== 0) {
    throw new Error(draw.stderr || "ffmpeg could not paint the code.");
  }
  const bytes = readFileSync(file);
  rmSync(file, { force: true });
  return bytes;
}

function paintedCode(): string {
  const alphabet = "2347AKMTXY".split("");
  return Array.from({ length: 4 }, () => {
    const index = randomInt(alphabet.length);
    return alphabet[index] ?? "2";
  }).join("");
}

test("the code image does not contain the code as text", () => {
  const code = "K7QM";
  const png = codeImage(code);
  expect(png.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  expect(png.includes(Buffer.from(code))).toBe(false);
  expect(new Set(scanlineFilters(png))).toEqual(new Set([0]));
});

const canPaint =
  fontFile !== undefined &&
  spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0;

test("the live check accepts a vision read of the saved file", () => {
  const directory = mkdtempSync(join(tmpdir(), "companion-vision-read-"));
  const path = join(directory, "images", "code.png");
  const png = Buffer.from("png-bytes");
  mkdirSync(join(directory, "images"));
  writeFileSync(path, png);
  try {
    expect(visionReadPath(visionTurn(path), directory)).toBe(path);
    expect(readFileSync(path)).toEqual(png);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an extra tool still counts when the vision subagent read the file", () => {
  const directory = mkdtempSync(join(tmpdir(), "companion-vision-extra-"));
  const path = join(directory, "images", "code.png");
  mkdirSync(join(directory, "images"));
  writeFileSync(path, Buffer.from("png-bytes"));
  try {
    const shell = tool("shell", { command: "python decode.py" });
    expect(visionReadPath([shell, ...visionTurn(path)], directory)).toBe(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the live check rejects a turn that never asks the vision subagent", () => {
  const directory = mkdtempSync(join(tmpdir(), "companion-vision-other-"));
  const path = join(directory, "images", "code.png");
  mkdirSync(join(directory, "images"));
  writeFileSync(path, Buffer.from("png-bytes"));
  try {
    const other = tool("subagent", { agent: "explore", prompt: path });
    const read = tool("read", { path }, [{ path }], {
      "opencode/child-session": { depth: 1 },
    });
    expect(() => visionReadPath([other, read], directory)).toThrow(
      /did not read/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.skipIf(!canPaint)("the painted code is not stored as text", () => {
  const code = "K7XM";
  const png = paintedImage(code);
  expect(png.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  expect(png.includes(Buffer.from(code))).toBe(false);
});

test.skipIf(!live)(
  "a pasted code is read by the vision subagent",
  async () => {
    if (
      spawnSync(opencodeBin, ["--version"], { encoding: "utf8" }).status !== 0
    ) {
      throw new Error(`COMPANION_LIVE=1 but ${opencodeBin} did not start.`);
    }
    const code = paintedCode();
    const png = paintedImage(code);
    const directory = mkdtempSync(join(tmpdir(), "companion-live-image-"));
    const daemon = await startDaemon({
      storePath: join(directory, "threads.db"),
      opencodeBin,
    });
    try {
      const created = await fetch(`${daemon.url}/bots`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Look" }),
      });
      expect(created.status).toBe(201);
      const bot = (await created.json()) as BotView;
      const response = await fetch(`${daemon.url}/bots/${bot.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "What code is painted in the attached image? Reply with only that code.",
          images: [{ mimeType: "image/png", data: png.toString("base64") }],
        }),
      });
      expect(response.status).toBe(200);
      const events = parseEvents(await response.text());
      const failure = events.find((event) => event.event === "error");
      expect(failure, JSON.stringify(events)).toBeUndefined();
      const updates = events.flatMap((event) =>
        event.event === "update" ? [event.data] : [],
      );
      const saved = visionReadPath(updates, bot.directory);
      expect(readFileSync(saved)).toEqual(png);
      expect(replyText(updates), JSON.stringify(events)).toContain(code);
    } finally {
      await daemon.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  480_000,
);

function parseEvents(body: string): TurnEvent[] {
  const events: TurnEvent[] = [];
  for (const block of body.split("\n\n")) {
    if (block.trim() === "") continue;
    let name = "";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) name = line.slice("event:".length).trim();
      if (line.startsWith("data:"))
        data.push(line.slice("data:".length).trim());
    }
    const payload: unknown = JSON.parse(data.join("\n"));
    if (name === "update") {
      events.push({ event: "update", data: payload as acp.SessionUpdate });
      continue;
    }
    if (name === "done") {
      events.push({
        event: "done",
        data: payload as { stopReason: acp.StopReason },
      });
      continue;
    }
    if (name === "error") {
      events.push({ event: "error", data: payload as { error: string } });
      continue;
    }
    throw new Error(`Unexpected event ${name}.`);
  }
  return events;
}

type SeenCall = {
  name?: string;
  rawInput?: unknown;
  locations?: { path: string }[];
  child: boolean;
};

/**
 * The file the vision subagent was asked to read.
 * Other tool calls are allowed. The turn still has to ask vision, and a child read has to open this file.
 */
function visionReadPath(
  updates: readonly acp.SessionUpdate[],
  directory: string,
): string {
  const calls = seenCalls(updates);
  const asked = calls
    .filter(
      (call) =>
        !call.child &&
        call.name === "subagent" &&
        inputAgent(call.rawInput) === visionAgentId,
    )
    .map((call) => inputPrompt(call.rawInput));
  const read = calls
    .filter((call) => call.child && call.name === "read")
    .map((call) => callPath(call))
    .find(
      (path) =>
        path !== undefined &&
        asked.some((prompt) => prompt.includes(path)) &&
        insideImages(directory, path) &&
        existsSync(path),
    );
  if (read === undefined) {
    throw new Error(
      "The vision subagent did not read the image saved for this turn.",
    );
  }
  return read;
}

/** One parent vision call and the child read of `path`, as OpenCode reports them. */
function visionTurn(path: string): acp.SessionUpdate[] {
  return [
    tool("subagent", {
      agent: visionAgentId,
      prompt: `Read the image at ${path}.`,
    }),
    tool("read", { path }, [{ path }], {
      "opencode/child-session": { depth: 1 },
    }),
  ];
}

function tool(
  name: string,
  rawInput: unknown,
  locations: { path: string }[] = [],
  meta?: Record<string, unknown>,
): acp.SessionUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId: name,
    title: name,
    name,
    locations,
    rawInput,
    ...(meta === undefined ? {} : { _meta: meta }),
  };
}

function seenCalls(updates: readonly acp.SessionUpdate[]): SeenCall[] {
  const calls = new Map<string, SeenCall>();
  for (const update of updates) {
    if (
      update.sessionUpdate !== "tool_call" &&
      update.sessionUpdate !== "tool_call_update"
    ) {
      continue;
    }
    const previous = calls.get(update.toolCallId) ?? { child: false };
    const meta = update._meta?.["opencode/child-session"];
    calls.set(update.toolCallId, {
      name: update.name ?? previous.name,
      rawInput: filled(update.rawInput) ? update.rawInput : previous.rawInput,
      locations:
        update.locations && update.locations.length > 0
          ? update.locations
          : previous.locations,
      child: previous.child || (meta !== undefined && meta !== null),
    });
  }
  return [...calls.values()];
}

function filled(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && Object.keys(value).length > 0
  );
}

function inputAgent(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("agent" in input)) {
    return undefined;
  }
  return typeof input.agent === "string" ? input.agent : undefined;
}

function inputPrompt(input: unknown): string {
  if (typeof input !== "object" || input === null || !("prompt" in input)) {
    return "";
  }
  return typeof input.prompt === "string" ? input.prompt : "";
}

function callPath(call: SeenCall): string | undefined {
  const located = call.locations?.find((location) => location.path.length > 0);
  if (located !== undefined) return located.path;
  if (typeof call.rawInput !== "object" || call.rawInput === null) {
    return undefined;
  }
  if (!("path" in call.rawInput)) return undefined;
  return typeof call.rawInput.path === "string"
    ? call.rawInput.path
    : undefined;
}

/** True when `path` is a file inside this bot's images folder. */
function insideImages(directory: string, path: string): boolean {
  if (!isAbsolute(path)) return false;
  const fromImages = relative(join(directory, "images"), path);
  return (
    fromImages.length > 0 &&
    !fromImages.startsWith("..") &&
    !isAbsolute(fromImages)
  );
}
