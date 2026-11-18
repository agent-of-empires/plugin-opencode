import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  REPLY_NAME,
  SNAPSHOT_NAME,
  readSnapshot,
  writeSnapshot,
  type Answer,
  type Prompt,
  type QuestionPrompt,
  type Snapshot,
} from "../opencode-extension/index.ts";
import { createFormRelay, planFormReply, type Form, type FormReply, type TuiContext } from "../opencode-extension/tui.ts";

const INSTANCE = "instance-a";
const SESSION = "ses_root";
const UID = process.getuid?.() ?? 0;
const PID = process.pid;
const RESPONSE_ID = "6f1f1b3e-1d2a-4c8e-9f1a-2b3c4d5e6f70";

function privateDirectory(): string {
  const root = mkdtempSync(path.join(tmpdir(), "aoe-opencode-tui-"));
  chmodSync(root, 0o700);
  return root;
}

function snapshot(prompt: Prompt | null, patch: Partial<Snapshot> = {}): Snapshot {
  return {
    schema_version: 1,
    instance_id: INSTANCE,
    provider_version: "2.3.0",
    provider_session_id: SESSION,
    writer_pid: PID,
    revision: 2,
    status: prompt ? "waiting" : "running",
    reply_keys: ["F12"],
    prompt,
    ...patch,
  };
}

function questionPrompt(ids: string[], labels: string[] = [], id = "frm_1"): QuestionPrompt {
  return {
    kind: "question",
    id,
    title: "Which environment?",
    questions: ids.map((key) => ({
      id: key,
      question: key,
      options: labels.map((label) => ({ label, description: null })),
      multi: false,
      recommended: null,
    })),
  };
}

function answers(entries: { id: string; selected?: string[]; custom?: string }[]): Answer[] {
  return entries.map((entry) => ({
    id: entry.id,
    selected_options: entry.selected ?? [],
    ...(entry.custom === undefined ? {} : { custom_input: entry.custom }),
  }));
}

const form: Form = {
  id: "frm_1",
  sessionID: SESSION,
  fields: [
    {
      key: "env",
      type: "string",
      required: true,
      options: [
        { value: "stg", label: "staging" },
        { value: "prd", label: "production" },
      ],
    },
    {
      key: "tags",
      type: "multiselect",
      options: [
        { value: "a", label: "alpha" },
        { value: "b", label: "beta" },
      ],
    },
    { key: "ok", type: "boolean" },
    { key: "count", type: "integer" },
    { key: "link", type: "external" },
    { key: "hidden", type: "string", hidden: true },
  ],
};

function writeReport(directory: string, report: Snapshot, entries: Parameters<typeof answers>[0]) {
  writeFileSync(
    path.join(directory, REPLY_NAME),
    `${JSON.stringify({
      schema_version: 1,
      instance_id: report.instance_id,
      provider_session_id: report.provider_session_id,
      writer_pid: report.writer_pid,
      revision: report.revision,
      prompt_id: report.prompt?.id,
      response_id: RESPONSE_ID,
      response: { kind: "question", answers: answers(entries) },
    })}\n`,
    { mode: 0o600 },
  );
  chmodSync(path.join(directory, REPLY_NAME), 0o600);
}

function contextWith(forms: () => Form[] | undefined, submitted: FormReply[], onSync?: () => void): TuiContext {
  return {
    data: {
      session: {
        form: {
          list: forms,
          sync: async () => {
            onSync?.();
          },
          reply: async (input) => {
            submitted.push(input);
          },
        },
      },
    },
  };
}

test("a form answer uses the field values the option labels stand for", () => {
  const prompt = questionPrompt(["env", "tags", "ok", "count"]);
  const filled = answers([
    { id: "env", selected: ["staging"] },
    { id: "tags", selected: ["alpha", "beta"] },
    { id: "ok", custom: "yes" },
    { id: "count", custom: "3" },
  ]);
  expect(planFormReply(snapshot(prompt), form, filled)).toEqual({
    sessionID: SESSION,
    formID: "frm_1",
    answer: { env: "stg", tags: ["a", "b"], ok: true, count: 3 },
  });
});

test("a free-text string field sends the typed answer", () => {
  const freeText: Form = {
    id: "frm_1",
    sessionID: SESSION,
    fields: [{ key: "env", type: "string", required: true }],
  };
  const prompt = questionPrompt(["env"]);
  expect(planFormReply(snapshot(prompt), freeText, answers([{ id: "env", custom: "staging-eu" }]))?.answer).toEqual({
    env: "staging-eu",
  });
});

test("hidden, external and inapplicable fields are left out of the answer", () => {
  const conditional: Form = {
    id: "frm_1",
    sessionID: SESSION,
    fields: [
      {
        key: "env",
        type: "string",
        options: [
          { value: "stg", label: "staging" },
          { value: "prd", label: "production" },
        ],
      },
      { key: "region", type: "string", when: [{ key: "env", op: "eq", value: "prd" }] },
      { key: "link", type: "external" },
      { key: "hidden", type: "string", hidden: true },
    ],
  };
  const prompt = questionPrompt(["env", "region"]);
  const filled = answers([
    { id: "env", selected: ["staging"] },
    { id: "region", custom: "eu" },
  ]);
  expect(planFormReply(snapshot(prompt), conditional, filled)?.answer).toEqual({ env: "stg" });
});

test("an answer for an unrelated or incomplete form is refused", () => {
  const prompt = questionPrompt(["env"]);
  const filled = answers([{ id: "env", selected: ["staging"] }]);
  expect(planFormReply(snapshot(prompt), { ...form, id: "frm_other" }, filled)).toBeUndefined();
  expect(planFormReply(snapshot(prompt), { ...form, sessionID: "ses_other" }, filled)).toBeUndefined();
  // env is required and unanswered, so no partial form is submitted.
  expect(planFormReply(snapshot(prompt), form, [])).toBeUndefined();
});


test("the relay answers the pending form once and removes the response", async () => {
  const directory = privateDirectory();
  try {
    const report = snapshot(questionPrompt(["env"], ["staging", "production"]));
    await writeSnapshot(directory, report);
    writeReport(directory, report, [{ id: "env", selected: ["staging"] }]);

    const submitted: FormReply[] = [];
    let synced = 0;
    const context = contextWith(() => [form], submitted, () => {
      synced += 1;
    });
    const relay = createFormRelay({ context, instanceId: INSTANCE, directory, uid: UID });
    expect(await relay.pollOnce()).toBe(true);
    expect(submitted).toEqual([{ sessionID: SESSION, formID: "frm_1", answer: { env: "stg" } }]);
    expect(synced).toBe(0);
    expect(await relay.pollOnce()).toBe(false);
    expect(submitted).toHaveLength(1);
    expect(readSnapshot(directory, UID, INSTANCE)).toBeDefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the relay syncs a form the TUI has not loaded yet", async () => {
  const directory = privateDirectory();
  try {
    const report = snapshot(questionPrompt(["env"], ["staging", "production"]));
    await writeSnapshot(directory, report);
    writeReport(directory, report, [{ id: "env", selected: ["staging"] }]);

    const submitted: FormReply[] = [];
    let forms: Form[] | undefined;
    const context = contextWith(
      () => forms,
      submitted,
      () => {
        forms = [form];
      },
    );
    expect(await createFormRelay({ context, instanceId: INSTANCE, directory, uid: UID }).pollOnce()).toBe(true);
    expect(submitted).toHaveLength(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the relay ignores a report without a question and one from another instance", async () => {
  const directory = privateDirectory();
  try {
    const submitted: FormReply[] = [];
    const context = contextWith(() => [form], submitted);

    const idle = snapshot(null);
    await writeSnapshot(directory, idle);
    expect(await createFormRelay({ context, instanceId: INSTANCE, directory, uid: UID }).pollOnce()).toBe(false);

    const other = snapshot(questionPrompt(["env"], ["staging"]), { instance_id: "instance-b" });
    await writeSnapshot(directory, other);
    writeReport(directory, other, [{ id: "env", selected: ["staging"] }]);
    expect(await createFormRelay({ context, instanceId: INSTANCE, directory, uid: UID }).pollOnce()).toBe(false);
    expect(submitted).toHaveLength(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the relay does not answer for a writer that has exited", async () => {
  const directory = privateDirectory();
  try {
    const report = snapshot(questionPrompt(["env"], ["staging"]), { writer_pid: 999_999 });
    await writeSnapshot(directory, report);
    writeReport(directory, report, [{ id: "env", selected: ["staging"] }]);
    const submitted: FormReply[] = [];
    expect(
      await createFormRelay({ context: contextWith(() => [form], submitted), instanceId: INSTANCE, directory, uid: UID }).pollOnce(),
    ).toBe(false);
    expect(submitted).toHaveLength(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the snapshot reader refuses a report another user could have written", async () => {
  const directory = privateDirectory();
  try {
    await writeSnapshot(directory, snapshot(null));
    chmodSync(path.join(directory, SNAPSHOT_NAME), 0o644);
    expect(readSnapshot(directory, UID, INSTANCE)).toBeUndefined();
    expect(readSnapshot(directory, UID, "instance-b")).toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
