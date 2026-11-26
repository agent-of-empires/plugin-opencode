import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  REPLY_NAME,
  SESSION_ID_NAME,
  SNAPSHOT_NAME,
  SUPPORTED_RANGES,
  approvalPrompt,
  classify,
  createBridge,
  createTracker,
  ensurePrivateDirectories,
  integrationDirectory,
  integrationPaths,
  isSupportedVersion,
  providerReply,
  questionPrompt,
  readReply,
  resolveInstanceId,
  satisfies,
  sessionIdLeaf,
  validateReply,
  writeSessionId,
  writeSnapshot,
} from "../opencode-extension/index.ts";

const INSTANCE = "instance-a";
const VERSION = "1.18.32";
const UID = process.getuid?.() ?? 0;
const PID = 4242;

function privateDirectory(): string {
  const root = mkdtempSync(path.join(tmpdir(), "aoe-opencode-test-"));
  chmodSync(root, 0o700);
  return root;
}

function event(type: string, properties: Record<string, unknown> = {}) {
  return { type, properties };
}

const approvalRequest = {
  id: "per_abc",
  sessionID: "ses_root",
  permission: "bash",
  patterns: ["npm test"],
  metadata: {},
  always: ["npm *"],
};

const questionRequest = {
  id: "que_abc",
  sessionID: "ses_root",
  questions: [
    {
      question: "Which environment?",
      header: "Env",
      options: [
        { label: "staging", description: "Pre-production" },
        { label: "production" },
      ],
      multiple: false,
    },
  ],
};

test("the declared provider ranges cover supported OpenCode generations only", () => {
  expect(isSupportedVersion("1.18.29")).toBe(true);
  expect(isSupportedVersion("1.18.32")).toBe(true);
  expect(isSupportedVersion("1.19.0")).toBe(true);
  expect(isSupportedVersion("1.18.28")).toBe(false);
  expect(isSupportedVersion("2.0.0-beta.19242")).toBe(true);
  expect(isSupportedVersion("2.4.1")).toBe(true);
  expect(isSupportedVersion("3.0.0")).toBe(false);
  expect(isSupportedVersion("not-a-version")).toBe(false);
  expect(isSupportedVersion(undefined)).toBe(false);
});

test("semver matching fails closed on unknown syntax and honours prereleases", () => {
  expect(satisfies("1.2.3", [">=1.2.0, <2.0.0"])).toBe(true);
  expect(satisfies("1.2.3", ["^1.0.0"])).toBe(true);
  expect(satisfies("2.0.0", ["^1.0.0"])).toBe(false);
  expect(satisfies("2.0.0-rc.1", [">=1.0.0, <3.0.0"])).toBe(false);
  expect(satisfies("2.0.0-rc.1", [">=2.0.0-0, <3.0.0"])).toBe(true);
  expect(satisfies("1.2.3", ["nonsense"])).toBe(false);
  expect(satisfies(VERSION, SUPPORTED_RANGES)).toBe(true);
});

test("permission and question events publish AoE prompts", () => {
  const tracker = createTracker();
  const approval = classify(event("permission.asked", approvalRequest), tracker);
  expect(approval.status).toBe("waiting");
  expect(approval.prompt).toEqual({
    kind: "approval",
    id: "per_abc",
    title: "bash: npm test",
    allow_always: true,
  });

  const question = classify(event("question.asked", questionRequest), tracker);
  expect(question.prompt).toEqual({
    kind: "question",
    id: "que_abc",
    title: "Which environment?",
    questions: [
      {
        id: "que_abc:0",
        question: "Which environment?",
        options: [
          { label: "staging", description: "Pre-production" },
          { label: "production", description: null },
        ],
        multi: false,
        recommended: null,
      },
    ],
  });
});

test("status events map to running, idle and error, and a reply clears the prompt", () => {
  const tracker = createTracker();
  expect(classify(event("session.status", { sessionID: "ses", status: { type: "busy" } }), tracker).status).toBe(
    "running",
  );
  expect(classify(event("session.status", { sessionID: "ses", status: "idle" }), tracker).status).toBe("idle");
  expect(classify(event("session.status", { sessionID: "ses", status: "teleporting" }), tracker).status).toBeUndefined();
  expect(classify(event("session.idle", { sessionID: "ses" }), tracker).status).toBe("idle");
  expect(classify(event("session.error", { sessionID: "ses" }), tracker).status).toBe("error");
  expect(classify(event("permission.replied", { sessionID: "ses" }), tracker)).toMatchObject({
    status: "running",
    prompt: null,
  });
});

function v2Event(type: string, data: Record<string, unknown> = {}) {
  return { id: "evt_1", created: 1, type, data };
}

test("V2 events publish the same statuses and prompts through their data envelope", () => {
  const tracker = createTracker();
  expect(classify(v2Event("session.execution.started", { sessionID: "ses_v2" }), tracker).status).toBe("running");
  expect(classify(v2Event("session.execution.succeeded", { sessionID: "ses_v2" }), tracker).status).toBe("idle");
  expect(classify(v2Event("session.execution.failed", { sessionID: "ses_v2" }), tracker).status).toBe("error");
  expect(classify(v2Event("session.execution.interrupted", { sessionID: "ses_v2" }), tracker).status).toBe("idle");
  expect(classify(v2Event("session.tool.called", { sessionID: "ses_v2" }), tracker).status).toBe("running");

  const prompt = classify(
    v2Event("permission.asked", {
      id: "per_v2",
      sessionID: "ses_v2",
      action: "shell",
      resources: ["echo hi"],
      save: ["echo *"],
    }),
    tracker,
  );
  expect(prompt.status).toBe("waiting");
  expect(prompt.prompt).toEqual({ kind: "approval", id: "per_v2", title: "shell: echo hi", allow_always: true });

  const child = classify(v2Event("session.created", { sessionID: "ses_child", parentID: "ses_v2" }), tracker);
  expect(child.child).toBe(true);
  expect(classify(v2Event("session.execution.succeeded", { sessionID: "ses_child" }), tracker).status).toBeUndefined();
});

test("a child session cannot move the root status but its prompt is answerable", () => {
  const tracker = createTracker();
  classify(event("session.created", { sessionID: "ses_child", info: { id: "ses_child", parentID: "ses_root" } }), tracker);
  const status = classify(event("session.status", { sessionID: "ses_child", status: "idle" }), tracker);
  expect(status).toMatchObject({ child: true });
  expect(status.status).toBeUndefined();
  const prompt = classify(event("permission.asked", { ...approvalRequest, id: "per_child", sessionID: "ses_child" }), tracker);
  expect(prompt.status).toBe("waiting");
  expect(prompt.prompt?.id).toBe("per_child");
});

test("malformed prompts are dropped instead of publishing an unusable dialog", () => {
  expect(approvalPrompt({})).toBeUndefined();
  expect(questionPrompt({ id: "que", questions: [] })).toBeUndefined();
  expect(questionPrompt({ id: "que", questions: [{ question: "Pick", options: [] }] })).toBeUndefined();
  expect(
    questionPrompt({ id: "que", questions: [{ question: "Pick", options: [{ label: "a" }, { label: "a" }] }] }),
  ).toBeUndefined();
});

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    instance_id: INSTANCE,
    provider_version: VERSION,
    provider_session_id: "ses_root",
    writer_pid: PID,
    revision: 3,
    status: "waiting" as const,
    reply_keys: ["F12"],
    prompt: {
      kind: "approval" as const,
      id: "per_abc",
      title: "bash: npm test",
      allow_always: false,
    },
    ...overrides,
  };
}

function reply(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    instance_id: INSTANCE,
    provider_session_id: "ses_root",
    writer_pid: PID,
    revision: 3,
    prompt_id: "per_abc",
    response_id: "7d442dd2-7b10-4cc4-9207-123456789abc",
    response: { kind: "approval", choice: "allow" },
    ...overrides,
  };
}

test("a reply is accepted only for the live prompt and revision", () => {
  const live = snapshot();
  expect(validateReply(reply(), live)).toBe(true);
  expect(validateReply(reply({ revision: 2 }), live)).toBe(false);
  expect(validateReply(reply({ prompt_id: "per_other" }), live)).toBe(false);
  expect(validateReply(reply({ instance_id: "instance-b" }), live)).toBe(false);
  expect(validateReply(reply({ response_id: "not-a-uuid" }), live)).toBe(false);
  expect(validateReply(reply({ response: { kind: "approval", choice: "allow_always" } }), live)).toBe(false);
  expect(validateReply(reply(), snapshot({ prompt: { ...live.prompt, allow_always: true } }))).toBe(true);
});

test("question replies require one selection or a custom answer per question", () => {
  const prompt = {
    kind: "question" as const,
    id: "que_abc",
    title: "Pick",
    questions: [
      {
        id: "que_abc:0",
        question: "Pick",
        options: [{ label: "a", description: null }],
        multi: false,
        recommended: null,
      },
    ],
  };
  const live = snapshot({ prompt });
  const answer = (entry: Record<string, unknown>) =>
    reply({ prompt_id: "que_abc", response: { kind: "question", answers: [entry] } });
  expect(validateReply(answer({ id: "que_abc:0", selected_options: ["a"] }), live)).toBe(true);
  expect(validateReply(answer({ id: "que_abc:0", selected_options: [], custom_input: "b" }), live)).toBe(true);
  expect(validateReply(answer({ id: "que_abc:0", selected_options: [] }), live)).toBe(false);
  expect(validateReply(answer({ id: "que_abc:0", selected_options: ["a"], custom_input: "b" }), live)).toBe(false);
  expect(validateReply(answer({ id: "que_abc:0", selected_options: ["z"] }), live)).toBe(false);
});

test("AoE choices become OpenCode decisions and positional answers", () => {
  const approval = { kind: "approval" as const, id: "per", title: "bash", allow_always: true };
  expect(providerReply(approval, reply() as any)).toEqual({ kind: "approval", choice: "once" });
  expect(
    providerReply(approval, reply({ response: { kind: "approval", choice: "allow_always" } }) as any),
  ).toEqual({ kind: "approval", choice: "always" });
  expect(providerReply(approval, reply({ response: { kind: "approval", choice: "deny" } }) as any)).toEqual({
    kind: "approval",
    choice: "reject",
  });
  const question = {
    kind: "question" as const,
    id: "que_abc",
    title: "Pick",
    questions: [
      { id: "que_abc:0", question: "Pick", options: [{ label: "a", description: null }], multi: false, recommended: null },
    ],
  };
  expect(
    providerReply(question, {
      response: {
        kind: "question",
        answers: [{ id: "que_abc:0", selected_options: ["a"], custom_input: "other" }],
      },
    } as any),
  ).toEqual({ kind: "question", answers: [["a", "other"]] });
});

test("reports round-trip through a private directory and replies are read back", async () => {
  const root = privateDirectory();
  try {
    expect(await ensurePrivateDirectories(root, path.join(root, INSTANCE), UID)).toBe(true);
    const directory = path.join(root, INSTANCE);
    await writeSnapshot(directory, snapshot());
    expect(readdirSync(directory)).toEqual([SNAPSHOT_NAME]);
    expect(statSync(path.join(directory, SNAPSHOT_NAME)).mode & 0o777).toBe(0o600);
    expect(readReply(directory, UID, snapshot())).toBeUndefined();
    writeFileSync(path.join(directory, REPLY_NAME), JSON.stringify(reply()), { mode: 0o600 });
    expect(readReply(directory, UID, snapshot())?.response_id).toBe(reply().response_id);
    chmodSync(path.join(directory, REPLY_NAME), 0o644);
    expect(readReply(directory, UID, snapshot())).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a configured directory needs a parent others cannot write, but not a private one", async () => {
  const parent = privateDirectory();
  try {
    // Root-owned or ordinary 0755 parents are fine: nobody else can rename the
    // leaf, so only the leaf has to be private and provider-owned.
    chmodSync(parent, 0o755);
    const configured = path.join(parent, INSTANCE);
    expect(await ensurePrivateDirectories(parent, configured, UID, false)).toBe(true);
    expect(statSync(configured).mode & 0o777).toBe(0o700);
    // The namespace this extension creates still requires both levels.
    expect(await ensurePrivateDirectories(parent, path.join(parent, "managed"), UID)).toBe(false);

    // A parent another user can add or rename entries in lets them swap the
    // private leaf after this check, so it is refused.
    chmodSync(parent, 0o777);
    expect(await ensurePrivateDirectories(parent, path.join(parent, "swappable"), UID, false)).toBe(false);

    // The sticky bit is what makes a shared directory safe, which is how a
    // configured directory under /tmp stays usable.
    chmodSync(parent, 0o1777);
    expect(await ensurePrivateDirectories(parent, path.join(parent, "sticky"), UID, false)).toBe(true);

    // A writable ancestor is just as good a way to swap the leaf, so the whole
    // chain is checked, not only the immediate parent.
    chmodSync(parent, 0o755);
    const open = path.join(parent, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    const nested = path.join(open, "ns", INSTANCE);
    mkdirSync(path.join(open, "ns"));
    chmodSync(path.join(open, "ns"), 0o755);
    expect(await ensurePrivateDirectories(path.join(open, "ns"), nested, UID, false)).toBe(false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a configured directory follows a trusted alias but not an untrusted one", async () => {
  const root = privateDirectory();
  try {
    const real = path.join(root, "real");
    mkdirSync(real, { mode: 0o755 });
    const alias = path.join(root, "alias");
    symlinkSync(real, alias);
    // This uid owns the alias and nobody else can replace it, which is how a
    // configured directory under /tmp on macOS works, since /tmp is a symlink.
    expect(await ensurePrivateDirectories(alias, path.join(alias, INSTANCE), UID, false)).toBe(true);
    // A trusted alias is not enough if it leads into a directory another user
    // can write to, so the resolved ancestors are checked as well.
    const open = path.join(root, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    const deep = path.join(open, "deep");
    mkdirSync(deep);
    const unsafeAlias = path.join(root, "unsafe-alias");
    symlinkSync(deep, unsafeAlias);
    expect(await ensurePrivateDirectories(unsafeAlias, path.join(unsafeAlias, INSTANCE), UID, false)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed publication leaves no temporary file behind", async () => {
  const root = privateDirectory();
  try {
    const directory = path.join(root, INSTANCE);
    await ensurePrivateDirectories(root, directory, UID);
    // A directory at the target makes `rename` fail after the temporary file is
    // written and closed.
    mkdirSync(path.join(directory, SESSION_ID_NAME));
    await expect(writeSessionId(directory, SESSION_ID_NAME, "ses_root")).rejects.toThrow();
    expect(readdirSync(directory)).toEqual([SESSION_ID_NAME]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent publishes settle on one file and leave no temporary behind", async () => {
  const root = privateDirectory();
  try {
    const directory = path.join(root, INSTANCE);
    await ensurePrivateDirectories(root, directory, UID);
    const writes = Array.from({ length: 8 }, (_, index) =>
      writeSnapshot(directory, { ...snapshot(), revision: index }),
    );
    await Promise.all(writes);
    expect(readdirSync(directory)).toEqual([SNAPSHOT_NAME]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a heartbeat publish racing an event publish cannot fail the flush", async () => {
  const root = privateDirectory();
  try {
    const directory = path.join(root, INSTANCE);
    await ensurePrivateDirectories(root, directory, UID);
    const bridge = createBridge({
      instanceId: INSTANCE,
      directory,
      providerVersion: VERSION,
      uid: UID,
      pid: PID,
      // Explicit, so an inherited AOE_SESSION_SOURCE cannot move the leaf.
      sessionIdLeaf: SESSION_ID_NAME,
      respond: async () => {},
    });
    bridge.start();
    try {
      await Promise.all([
        bridge.observe(event("session.created", { sessionID: "ses_root" })),
        bridge.observe(event("session.status", { sessionID: "ses_root", status: "busy" })),
        bridge.flush(),
        bridge.flush(),
      ]);
      expect(readdirSync(directory).sort()).toEqual([SNAPSHOT_NAME, SESSION_ID_NAME]);
      expect(readFileSync(path.join(directory, SESSION_ID_NAME), "utf8")).toBe("ses_root");
      expect(bridge.snapshot()?.status).toBe("running");
    } finally {
      bridge.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the bridge publishes transitions, applies one reply, and ignores a stale duplicate", async () => {
  const root = privateDirectory();
  const delivered: unknown[] = [];
  try {
    const directory = path.join(root, INSTANCE);
    await ensurePrivateDirectories(root, directory, UID);
    const bridge = createBridge({
      instanceId: INSTANCE,
      directory,
      providerVersion: VERSION,
      uid: UID,
      pid: PID,
      respond: async (prompt, value) => {
        delivered.push(providerReply(prompt, value));
      },
    });

    await bridge.observe(event("session.created", { sessionID: "ses_root", info: { id: "ses_root" } }));
    // A session with no reported status yet publishes nothing.
    expect(bridge.snapshot()).toBeUndefined();
    await bridge.observe(event("session.status", { sessionID: "ses_root", status: { type: "idle" } }));
    expect(bridge.snapshot()).toMatchObject({ status: "idle", prompt: null, revision: 1, reply_keys: ["F12"] });

    await bridge.observe(event("permission.asked", approvalRequest));
    const waiting = bridge.snapshot()!;
    expect(waiting).toMatchObject({ status: "waiting", revision: 2 });
    expect(waiting.prompt?.id).toBe("per_abc");
    expect(readReply(directory, UID, waiting)).toBeUndefined();

    writeFileSync(path.join(directory, REPLY_NAME), JSON.stringify(reply({ revision: waiting.revision })), {
      mode: 0o600,
    });
    expect(await bridge.pollReply()).toBe(true);
    expect(delivered).toEqual([{ kind: "approval", choice: "once" }]);
    expect(bridge.snapshot()).toMatchObject({ status: "running", prompt: null, revision: 3 });

    writeFileSync(path.join(directory, REPLY_NAME), JSON.stringify(reply({ revision: 2 })), { mode: 0o600 });
    expect(await bridge.pollReply()).toBe(false);
    expect(delivered).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unsupported provider version publishes status without prompts or replies", async () => {
  const root = privateDirectory();
  try {
    const directory = path.join(root, INSTANCE);
    await ensurePrivateDirectories(root, directory, UID);
    const bridge = createBridge({
      instanceId: INSTANCE,
      directory,
      providerVersion: "3.0.0",
      uid: UID,
      pid: PID,
      respond: async () => {
        throw new Error("an unsupported version must never reply");
      },
    });
    await bridge.observe(event("session.created", { sessionID: "ses_root" }));
    await bridge.observe(event("session.status", { sessionID: "ses_root", status: "busy" }));
    await bridge.observe(event("permission.asked", approvalRequest));
    const snapshot = bridge.snapshot()!;
    expect(snapshot).toMatchObject({ status: "running", prompt: null, reply_keys: [], provider_version: "3.0.0" });
    writeFileSync(path.join(directory, REPLY_NAME), JSON.stringify(reply()), { mode: 0o600 });
    expect(await bridge.pollReply()).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("instance identity comes from AoE's environment or the pane's tmux environment", () => {
  expect(resolveInstanceId({ AOE_INSTANCE_ID: "instance-a" }, () => undefined)).toBe("instance-a");
  expect(resolveInstanceId({ AOE_INSTANCE_ID: "../escape" }, () => undefined)).toBeUndefined();
  expect(resolveInstanceId({ TMUX_PANE: "%4" }, () => "AOE_INSTANCE_ID=instance-b")).toBe("instance-b");
  expect(resolveInstanceId({ TMUX_PANE: "%4" }, () => "AOE_INSTANCE_ID=bad id")).toBeUndefined();
  expect(resolveInstanceId({}, () => undefined)).toBeUndefined();
  expect(integrationDirectory(501, "instance-a")).toBe("/tmp/aoe-hooks-501/instance-a");
});

test("a launch names the integration directory and the leaf its id belongs to", () => {
  expect(integrationPaths({}, 501, "instance-a")).toEqual({
    root: "/tmp/aoe-hooks-501",
    dir: "/tmp/aoe-hooks-501/instance-a",
    managed: true,
  });
  expect(integrationPaths({ AOE_INTEGRATION_DIR: "/tmp/aoe-hooks/instance-a" }, 501, "instance-a")).toEqual({
    root: "/tmp/aoe-hooks",
    dir: "/tmp/aoe-hooks/instance-a",
    managed: false,
  });
  const launchId = "7d442dd2-7b10-4cc4-9207-123456789abc";
  expect(sessionIdLeaf(launchId)).toBe(`session_id.${launchId}`);
  expect(sessionIdLeaf(undefined)).toBe("session_id");
  expect(sessionIdLeaf("not-a-launch-id")).toBe("session_id");
  expect(sessionIdLeaf("7D442DD2-7B10-4CC4-9207-123456789ABC")).toBe("session_id");
});

test("the bridge publishes the root conversation id next to its report", async () => {
  const directory = privateDirectory();
  const launchId = "7d442dd2-7b10-4cc4-9207-123456789abc";
  const leaf = sessionIdLeaf(launchId);
  const bridge = createBridge({
    instanceId: INSTANCE,
    directory,
    providerVersion: VERSION,
    uid: UID,
    pid: PID,
    sessionIdLeaf: leaf,
    respond: async () => {},
  });
  try {
    await bridge.observe(event("session.created", { sessionID: "ses_root" }));
    await bridge.observe(event("session.status", { sessionID: "ses_root", status: "busy" }));
    expect(readFileSync(path.join(directory, leaf), "utf8")).toBe("ses_root");
    expect(statSync(path.join(directory, leaf)).mode & 0o777).toBe(0o600);
  } finally {
    bridge.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
