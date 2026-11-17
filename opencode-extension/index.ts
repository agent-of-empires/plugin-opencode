// OpenCode companion extension for Agent of Empires.
//
// Publishes OpenCode's own session status, pending permission and question
// prompts, and the user's AoE reply back into OpenCode. AoE consumes the report
// through the plugin manifest's `session.integration` declaration; pane
// detection stays in charge whenever this extension is missing, disabled, or
// running on a provider version it does not support.
//
// One entrypoint serves both OpenCode generations:
//   * OpenCode 1.x loads `server()` (the PluginModule default export's `server`).
//   * OpenCode 2.x loads `setup(ctx)` and subscribes to the event bus.

import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const SNAPSHOT_NAME = "integration-agent-of-empires.opencode.json";
export const REPLY_NAME = "integration-agent-of-empires.opencode.reply.json";
export const HEARTBEAT_MS = 5_000;
export const REPLY_POLL_MS = 250;
export const MAX_FILE_BYTES = 65_536;
export const REPLY_KEY = "F12";

/// Declared in `aoe-plugin.toml` as well. The host decides compatibility from
/// the published version; this copy keeps an unsupported runtime from driving
/// reply APIs it cannot honour.
export const SUPPORTED_RANGES = [">=1.18.29, <2.0.0", ">=2.0.0-0, <3.0.0"] as const;

export type Status = "running" | "waiting" | "idle" | "error";
export type ApprovalPrompt = { kind: "approval"; id: string; title: string; allow_always: boolean };
export type Question = {
  id: string;
  question: string;
  options: { label: string; description: string | null }[];
  multi: boolean;
  recommended: number | null;
};
export type QuestionPrompt = { kind: "question"; id: string; title: string; questions: Question[] };
export type Prompt = ApprovalPrompt | QuestionPrompt;

export type Snapshot = {
  schema_version: number;
  instance_id: string;
  provider_version: string;
  provider_session_id: string;
  writer_pid: number;
  revision: number;
  status: Status;
  reply_keys: string[];
  prompt: Prompt | null;
};

export type Answer = { id: string; selected_options: string[]; custom_input?: string };
export type Reply = {
  schema_version: number;
  instance_id: string;
  provider_session_id: string;
  writer_pid: number;
  revision: number;
  prompt_id: string;
  response_id: string;
  response:
    | { kind: "approval"; choice: "allow" | "allow_always" | "deny" }
    | { kind: "question"; answers: Answer[] };
};

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Version gate
// ---------------------------------------------------------------------------

type Version = { core: [number, number, number]; pre: string[] };

function parseVersion(value: string): Version | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    value.trim(),
  );
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

function compareVersions(left: Version, right: Version): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left.core[index] - right.core[index];
    if (difference !== 0) return difference;
  }
  // A release outranks any prerelease of the same core version.
  if (left.pre.length === 0 || right.pre.length === 0) {
    return right.pre.length - left.pre.length;
  }
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const a = left.pre[index];
    const b = right.pre[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const difference = Number(a) - Number(b);
      if (difference !== 0) return difference;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

type Comparator = { operator: ">=" | "<=" | ">" | "<" | "="; version: Version };

function parseComparators(range: string): Comparator[] | undefined {
  const tokens = range.split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) return undefined;
  const comparators: Comparator[] = [];
  for (const raw of tokens) {
    const caret = raw.startsWith("^");
    const tilde = raw.startsWith("~");
    const match = /^(>=|<=|>|<|=)?v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(
      caret || tilde ? raw.slice(1) : raw,
    );
    if (!match) return undefined;
    const version = parseVersion(
      `${match[2]}.${match[3]}.${match[4]}${match[5] ? `-${match[5]}` : ""}`,
    );
    if (!version) return undefined;
    if (caret || tilde) {
      const [major, minor, patch] = version.core;
      const upper: Version = caret
        ? major > 0
          ? { core: [major + 1, 0, 0], pre: [] }
          : minor > 0
            ? { core: [0, minor + 1, 0], pre: [] }
            : { core: [0, 0, patch + 1], pre: [] }
        : { core: [major, minor + 1, 0], pre: [] };
      comparators.push({ operator: ">=", version }, { operator: "<", version: upper });
      continue;
    }
    comparators.push({ operator: match[1] ?? "=", version });
  }
  return comparators;
}

function matchesComparator(subject: Version, comparator: Comparator): boolean {
  const order = compareVersions(subject, comparator.version);
  switch (comparator.operator) {
    case ">=":
      return order >= 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    case "<":
      return order < 0;
    case "=":
      return order === 0;
  }
}

/// Minimal semver range matching for the ranges this integration declares.
/// Unknown syntax fails closed.
export function satisfies(version: string, ranges: readonly string[]): boolean {
  const subject = parseVersion(version);
  if (!subject) return false;
  return ranges.some((range) => {
    const comparators = parseComparators(range);
    if (!comparators) return false;
    // Semver: a prerelease is in range only when a comparator names a
    // prerelease of the same core version.
    if (subject.pre.length > 0) {
      const allowsPrerelease = comparators.some(
        (comparator) =>
          comparator.version.pre.length > 0 &&
          comparator.version.core.every((part, index) => part === subject.core[index]),
      );
      if (!allowsPrerelease) return false;
    }
    return comparators.every((comparator) => matchesComparator(subject, comparator));
  });
}

export function isSupportedVersion(version: string | undefined): boolean {
  return !!version && satisfies(version, SUPPORTED_RANGES);
}

// ---------------------------------------------------------------------------
// Event classification
// ---------------------------------------------------------------------------

const STATUS_BY_KIND: ReadonlyMap<string, Status> = new Map([
  ["idle", "idle"],
  ["active", "running"],
  ["busy", "running"],
  ["pending", "running"],
  ["retry", "running"],
  ["running", "running"],
  ["streaming", "running"],
  ["working", "running"],
]);

const RUNNING_EVENTS = new Set([
  "tool.execute.before",
  "tool.execute.after",
  "permission.replied",
  "question.replied",
  "question.rejected",
  "session.compacted",
  "chat.message",
]);

const PROMPT_EVENTS = new Set(["permission.asked", "permission.v2.asked", "question.asked", "question.v2.asked"]);

export type Tracker = { childSessions: Set<string> };

export function createTracker(): Tracker {
  return { childSessions: new Set() };
}

export type Outcome = {
  rootSessionID?: string;
  sessionID?: string;
  status?: Status;
  prompt?: Prompt | null;
  child: boolean;
};

function sessionIDOf(properties: Record<string, any>): string | undefined {
  return typeof properties.sessionID === "string" && properties.sessionID
    ? properties.sessionID
    : undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function approvalPrompt(request: Record<string, any>): ApprovalPrompt | undefined {
  const id = textOf(request.id);
  if (!id) return undefined;
  const action = textOf(request.permission) ?? "permission";
  const patterns = Array.isArray(request.patterns)
    ? request.patterns.filter((pattern: unknown) => typeof pattern === "string")
    : [];
  const detail = patterns.length > 0 ? `${action}: ${patterns.join(" ")}` : action;
  return { kind: "approval", id, title: detail.slice(0, 200), allow_always: Array.isArray(request.always) && request.always.length > 0 };
}

export function questionPrompt(request: Record<string, any>): QuestionPrompt | undefined {
  const id = textOf(request.id);
  if (!id) return undefined;
  const raw = Array.isArray(request.questions) ? request.questions : [];
  const questions: Question[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) return undefined;
    const question = textOf(entry.question);
    const options = Array.isArray(entry.options) ? entry.options : [];
    const labels = new Set<string>();
    const mapped: Question["options"] = [];
    for (const option of options) {
      if (!isRecord(option)) return undefined;
      const label = textOf(option.label);
      if (!label || labels.has(label)) return undefined;
      labels.add(label);
      mapped.push({ label, description: textOf(option.description) ?? null });
    }
    if (!question || mapped.length === 0) return undefined;
    questions.push({
      id: `${id}:${index}`,
      question,
      options: mapped,
      multi: entry.multiple === true || entry.multi === true,
      recommended: null,
    });
  }
  if (questions.length === 0) return undefined;
  return {
    kind: "question",
    id,
    title: questions.map((question) => question.question).join("\n").slice(0, 400),
    questions,
  };
}

/// Classify one OpenCode bus event. Unknown events change nothing; events from
/// a child (subagent) session never move the root session's status, but a
/// prompt raised there still has to be answerable.
export function classify(event: unknown, tracker: Tracker): Outcome {
  const record = isRecord(event) ? event : {};
  const type = textOf(record.type);
  const properties = isRecord(record.properties) ? record.properties : {};
  if (!type) return { child: false };

  const info = isRecord(properties.info) ? properties.info : {};
  const sessionID = sessionIDOf(properties);
  const childSessionID =
    typeof info.id === "string" && typeof info.parentID === "string" && info.parentID !== info.id
      ? info.id
      : undefined;
  if (childSessionID) tracker.childSessions.add(childSessionID);
  const child = !!sessionID && tracker.childSessions.has(sessionID);

  if (type === "permission.asked" || type === "permission.v2.asked") {
    return { child, sessionID, prompt: approvalPrompt(properties) ?? null, status: "waiting" };
  }
  if (type === "question.asked" || type === "question.v2.asked") {
    return { child, sessionID, prompt: questionPrompt(properties) ?? null, status: "waiting" };
  }
  if (child) {
    return { child };
  }
  if (type === "session.created") {
    return { child, sessionID, rootSessionID: sessionID };
  }
  if (type === "session.updated") {
    return { child, sessionID, rootSessionID: sessionID };
  }
  if (type === "session.status") {
    const kind = textOf(properties.status?.type) ?? textOf(properties.status);
    const status = kind ? STATUS_BY_KIND.get(kind.toLowerCase()) : undefined;
    return status ? { child, sessionID, status } : { child, sessionID };
  }
  if (type === "session.idle") {
    return { child, sessionID, status: "idle" };
  }
  if (type === "session.error") {
    return { child, sessionID, status: "error" };
  }
  if (type === "session.deleted") {
    return { child, sessionID };
  }
  if (RUNNING_EVENTS.has(type)) {
    const clear = type === "permission.replied" || type === "question.replied" || type === "question.rejected";
    return { child, sessionID, status: "running", prompt: clear ? null : undefined };
  }
  if (PROMPT_EVENTS.has(type)) {
    return { child, sessionID };
  }
  return { child, sessionID };
}

// ---------------------------------------------------------------------------
// Reply validation
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateReply(value: unknown, snapshot: Snapshot): value is Reply {
  if (
    !isRecord(value) ||
    value.schema_version !== SNAPSHOT_SCHEMA_VERSION ||
    value.instance_id !== snapshot.instance_id ||
    value.provider_session_id !== snapshot.provider_session_id ||
    value.writer_pid !== snapshot.writer_pid ||
    value.revision !== snapshot.revision ||
    value.prompt_id !== snapshot.prompt?.id ||
    typeof value.response_id !== "string" ||
    !UUID.test(value.response_id) ||
    !isRecord(value.response)
  ) {
    return false;
  }
  const response = value.response;
  if (snapshot.prompt?.kind === "approval") {
    if (
      response.kind !== "approval" ||
      (response.choice !== "allow" && response.choice !== "allow_always" && response.choice !== "deny")
    ) {
      return false;
    }
    return response.choice !== "allow_always" || snapshot.prompt.allow_always;
  }
  if (snapshot.prompt?.kind !== "question" || response.kind !== "question" || !Array.isArray(response.answers)) {
    return false;
  }
  if (response.answers.length !== snapshot.prompt.questions.length) return false;
  return snapshot.prompt.questions.every((question, index) => {
    const answer = response.answers[index];
    if (!isRecord(answer) || answer.id !== question.id || !Array.isArray(answer.selected_options)) return false;
    if (
      !answer.selected_options.every(
        (label: unknown) => typeof label === "string" && question.options.some((option) => option.label === label),
      )
    ) {
      return false;
    }
    if (new Set(answer.selected_options).size !== answer.selected_options.length) return false;
    if (answer.custom_input !== undefined && (typeof answer.custom_input !== "string" || !answer.custom_input.trim())) {
      return false;
    }
    if (question.multi) return true;
    const hasOption = answer.selected_options.length === 1;
    const hasCustom = typeof answer.custom_input === "string" && answer.custom_input.trim().length > 0;
    return hasOption !== hasCustom;
  });
}

// ---------------------------------------------------------------------------
// Reply application
// ---------------------------------------------------------------------------

export type Responder = (
  prompt: Prompt,
  reply: Reply,
) => Promise<void>;

/// Translate an AoE reply into the provider call that commits it. Question
/// answers are positional label lists, matching OpenCode's `Question.Reply`.
export function providerReply(
  prompt: Prompt,
  reply: Reply,
): { kind: "approval"; choice: "once" | "always" | "reject" } | { kind: "question"; answers: string[][] } | undefined {
  if (prompt.kind === "approval" && reply.response.kind === "approval") {
    const choice = reply.response.choice;
    return { kind: "approval", choice: choice === "allow" ? "once" : choice === "allow_always" ? "always" : "reject" };
  }
  if (prompt.kind === "question" && reply.response.kind === "question") {
    const answers = reply.response.answers.map((answer) => {
      const custom = answer.custom_input?.trim();
      return custom ? [...answer.selected_options, custom] : [...answer.selected_options];
    });
    return { kind: "question", answers };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Report files
// ---------------------------------------------------------------------------

export function integrationDirectory(uid: number, instanceId: string): string {
  return path.join("/tmp", `aoe-hooks-${uid}`, instanceId);
}

function safeDirectorySync(directory: string, uid: number): boolean {
  try {
    const stat = lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o7777) === 0o700;
  } catch {
    return false;
  }
}

export async function ensurePrivateDirectories(root: string, directory: string, uid: number): Promise<boolean> {
  for (const entry of [root, directory]) {
    try {
      await mkdir(entry, { mode: 0o700 });
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") return false;
    }
    if (!safeDirectorySync(entry, uid)) return false;
  }
  return true;
}

export async function writeSnapshot(directory: string, snapshot: Snapshot): Promise<void> {
  const target = path.join(directory, SNAPSHOT_NAME);
  const temporary = path.join(directory, `.${SNAPSHOT_NAME}.${process.pid}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(snapshot)}\n`, "utf8");
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.write(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}

export function readReply(directory: string, uid: number, snapshot: Snapshot): Reply | undefined {
  const file = path.join(directory, REPLY_NAME);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600 || stat.size > MAX_FILE_BYTES) {
      return undefined;
    }
    const value: unknown = JSON.parse(readFileSync(descriptor, "utf8"));
    return validateReply(value, snapshot) ? value : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export type BridgeOptions = {
  instanceId: string;
  directory: string;
  providerVersion: string;
  supported?: boolean;
  respond: Responder;
  uid?: number;
  pid?: number;
  heartbeatMs?: number;
  pollMs?: number;
  log?: (message: string) => void;
};

export type Bridge = {
  observe(event: unknown): Promise<void>;
  snapshot(): Snapshot | undefined;
  flush(): Promise<void>;
  pollReply(): Promise<boolean>;
  start(): void;
  stop(): void;
};

export function createBridge(options: BridgeOptions): Bridge {
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const pid = options.pid ?? process.pid;
  const log = options.log ?? (() => {});
  const supported = options.supported ?? isSupportedVersion(options.providerVersion);
  const tracker = createTracker();
  let rootSessionID: string | undefined;
  let status: Status | undefined;
  let prompt: Prompt | null = null;
  let revision = 1;
  let written: string | undefined;
  let lastWrite = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  const applied = new Set<string>();

  const current = (): Snapshot | undefined => {
    const sessionID = rootSessionID ?? undefined;
    if (!supported || !sessionID || !status) return undefined;
    return {
      schema_version: SNAPSHOT_SCHEMA_VERSION,
      instance_id: options.instanceId,
      provider_version: options.providerVersion,
      provider_session_id: sessionID,
      writer_pid: pid,
      revision,
      status: prompt ? "waiting" : status,
      reply_keys: [REPLY_KEY],
      prompt,
    };
  };

  const flush = async (): Promise<void> => {
    const snapshot = current();
    if (!snapshot) return;
    const serialized = JSON.stringify(snapshot);
    const now = Date.now();
    if (serialized === written && now - lastWrite < (options.heartbeatMs ?? HEARTBEAT_MS)) return;
    try {
      await writeSnapshot(options.directory, snapshot);
      written = serialized;
      lastWrite = now;
    } catch (error) {
      log(`could not publish status: ${String(error)}`);
    }
  };

  const observe = async (event: unknown): Promise<void> => {
    if (!supported) return;
    const outcome = classify(event, tracker);
    if (outcome.rootSessionID) rootSessionID = outcome.rootSessionID;
    if (outcome.sessionID && !rootSessionID && !outcome.child) rootSessionID = outcome.sessionID;
    if (outcome.prompt !== undefined) {
      const changed = JSON.stringify(outcome.prompt) !== JSON.stringify(prompt);
      prompt = outcome.prompt;
      if (changed) revision += 1;
    }
    if (outcome.status) status = outcome.status;
    await flush();
  };

  const pollReply = async (): Promise<boolean> => {
    const snapshot = current();
    if (!snapshot || !snapshot.prompt) return false;
    const reply = readReply(options.directory, uid, snapshot);
    if (!reply || applied.has(reply.response_id)) return false;
    applied.add(reply.response_id);
    try {
      await options.respond(snapshot.prompt, reply);
    } catch (error) {
      log(`could not deliver reply: ${String(error)}`);
      return false;
    }
    try {
      await unlink(path.join(options.directory, REPLY_NAME));
    } catch {
      // The host replaces the file on the next response either way.
    }
    prompt = null;
    status = "running";
    revision += 1;
    written = undefined;
    await flush();
    return true;
  };

  return {
    observe,
    snapshot: current,
    flush,
    pollReply,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void flush();
      }, options.heartbeatMs ?? HEARTBEAT_MS);
      timer.unref?.();
      poller = setInterval(() => {
        void pollReply();
      }, options.pollMs ?? REPLY_POLL_MS);
      poller.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      if (poller) clearInterval(poller);
      timer = undefined;
      poller = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Host wiring
// ---------------------------------------------------------------------------

const ID = "aoe.opencode";
const DEBUG = () => process.env.AOE_OPENCODE_DEBUG === "1";

function log(message: string): void {
  if (DEBUG()) console.error(`[aoe-opencode] ${message}`);
}

export function resolveInstanceId(
  env: Record<string, string | undefined>,
  run: (file: string, args: string[]) => string | undefined,
): string | undefined {
  const direct = env.AOE_INSTANCE_ID?.trim();
  if (direct && /^[A-Za-z0-9_-]{1,128}$/.test(direct)) return direct;
  const pane = env.TMUX_PANE;
  if (!pane || !/^%[0-9]+$/.test(pane)) return undefined;
  const answer = run("tmux", ["show-environment", "-h", "-t", pane, "AOE_INSTANCE_ID"])?.trim();
  const value = answer?.startsWith("AOE_INSTANCE_ID=") ? answer.slice("AOE_INSTANCE_ID=".length) : "";
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

function runSync(file: string, args: string[]): string | undefined {
  try {
    return execFileSync(file, args, { encoding: "utf8", timeout: 1_000 });
  } catch {
    return undefined;
  }
}

function header(url: URL, directory?: string): HeadersInit {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (password) {
    headers.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  }
  if (directory) headers["x-opencode-directory"] = directory;
  return headers;
}

async function post(url: URL, body: unknown, directory?: string): Promise<void> {
  const response = await fetch(url, { method: "POST", headers: header(url, directory), body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${url.pathname} answered ${response.status}`);
}

async function serverVersion(serverUrl: URL): Promise<string | undefined> {
  try {
    const response = await fetch(new URL("/global/health", serverUrl), { headers: header(serverUrl) });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    return isRecord(body) && typeof body.version === "string" ? body.version : undefined;
  } catch {
    return undefined;
  }
}

type Wiring = { bridge: Bridge; close?: () => void };

async function v1(input: Record<string, any>): Promise<Wiring | undefined> {
  const instanceId = resolveInstanceId(process.env, runSync);
  if (!instanceId) return undefined;
  const serverUrl: URL = input?.serverUrl instanceof URL ? input.serverUrl : new URL(String(input?.serverUrl));
  const directory: string | undefined = typeof input?.directory === "string" ? input.directory : undefined;
  const version = await serverVersion(serverUrl);
  if (!version) {
    log("could not read the OpenCode version; leaving status to pane detection");
    return undefined;
  }
  if (!isSupportedVersion(version)) {
    log(
      `OpenCode ${version} is not supported by this integration (supported: ${SUPPORTED_RANGES.join(" or ")}); leaving status and replies to OpenCode and AoE's pane detection`,
    );
    return undefined;
  }
  const uid = process.getuid?.() ?? 0;
  const hookDirectory = integrationDirectory(uid, instanceId);
  if (!(await ensurePrivateDirectories(path.dirname(hookDirectory), hookDirectory, uid))) {
    log(`could not secure ${hookDirectory}; leaving status to pane detection`);
    return undefined;
  }
  const bridge = createBridge({
    instanceId,
    directory: hookDirectory,
    providerVersion: version,
    log,
    respond: async (prompt, reply) => {
      const call = providerReply(prompt, reply);
      if (!call) throw new Error("reply does not match the published prompt");
      const sessionID = bridge.snapshot()?.provider_session_id;
      if (!sessionID) throw new Error("no provider session to answer");
      if (call.kind === "approval") {
        // The deprecated session route is the only permission reply the 1.x
        // SDK exposes; the unsuffixed route is the same decision.
        const client = input?.client;
        if (typeof client?.postSessionIdPermissionsPermissionId === "function") {
          await client.postSessionIdPermissionsPermissionId({
            path: { id: sessionID, permissionID: prompt.id },
            body: { response: call.choice },
          });
          return;
        }
        await post(new URL(`/permission/${prompt.id}/reply`, serverUrl), { reply: call.choice }, directory);
        return;
      }
      await post(new URL(`/question/${prompt.id}/reply`, serverUrl), { answers: call.answers }, directory);
    },
  });
  bridge.start();
  return {
    bridge,
    close: () => bridge.stop(),
  };
}

async function v2(ctx: Record<string, any>): Promise<Wiring | undefined> {
  const instanceId = resolveInstanceId(process.env, runSync);
  if (!instanceId) return undefined;
  const version = typeof ctx?.app?.version === "string" ? ctx.app.version : undefined;
  if (!version) {
    log("could not read the OpenCode version; leaving status to pane detection");
    return undefined;
  }
  if (!isSupportedVersion(version)) {
    log(
      `OpenCode ${version} is not supported by this integration (supported: ${SUPPORTED_RANGES.join(" or ")}); leaving status and replies to OpenCode and AoE's pane detection`,
    );
    return undefined;
  }
  const uid = process.getuid?.() ?? 0;
  const hookDirectory = integrationDirectory(uid, instanceId);
  if (!(await ensurePrivateDirectories(path.dirname(hookDirectory), hookDirectory, uid))) {
    log(`could not secure ${hookDirectory}; leaving status to pane detection`);
    return undefined;
  }
  const bridge = createBridge({
    instanceId,
    directory: hookDirectory,
    providerVersion: version,
    log,
    respond: async (prompt, reply) => {
      const call = providerReply(prompt, reply);
      if (!call) throw new Error("reply does not match the published prompt");
      const sessionID = bridge.snapshot()?.provider_session_id;
      if (!sessionID) throw new Error("no provider session to answer");
      if (call.kind === "approval") {
        await ctx.permission.reply({ sessionID, requestID: prompt.id, decision: call.choice });
        return;
      }
      if (typeof ctx.question?.reply === "function") {
        await ctx.question.reply({ sessionID, requestID: prompt.id, answers: call.answers });
        return;
      }
      throw new Error("this OpenCode build exposes no question reply API; answer the prompt in OpenCode");
    },
  });
  bridge.start();
  const controller = new AbortController();
  const subscribe = ctx?.event?.subscribe;
  if (typeof subscribe === "function") {
    void (async () => {
      try {
        for await (const event of subscribe.call(ctx.event, { signal: controller.signal })) {
          try {
            await bridge.observe(event);
          } catch {
            // A single event must not kill the subscription.
          }
        }
      } catch {
        // The host is shutting down; pane detection covers the remainder.
      }
    })();
  }
  return {
    bridge,
    close: () => {
      controller.abort();
      bridge.stop();
    },
  };
}

async function server(input: Record<string, any>): Promise<Record<string, (event: unknown) => Promise<void>>> {
  const wiring = await v1(input);
  if (!wiring) return { event: async () => {} };
  return {
    event: async (event: unknown) => {
      try {
        await wiring.bridge.observe(event);
      } catch {
        // Reporting must never break the host session.
      }
    },
  };
}

async function setup(ctx: Record<string, any>): Promise<(() => void) | undefined> {
  const wiring = await v2(ctx);
  return wiring?.close;
}

export default { id: ID, setup, server };
export const AoeOpencodePlugin = server;
