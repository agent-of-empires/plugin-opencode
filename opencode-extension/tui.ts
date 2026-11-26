// OpenCode 2 TUI part for the AoE companion extension.
//
// OpenCode 2 asks through forms, and only its TUI context exposes a form reply
// (`context.data.session.form.reply`); the server context does not. The server
// part publishes a form as an AoE question prompt and leaves the AoE response
// on disk. This part watches that file, maps the response labels back onto the
// form's option values, and submits the answer through the TUI API.
//
// OpenCode resolves this file as the plugin's `tui` entrypoint beside
// `index.ts`. Without it, the prompt is published but must be answered in
// OpenCode.

import { unlink } from "node:fs/promises";
import path from "node:path";

import {
  REPLY_NAME,
  REPLY_POLL_MS,
  integrationPaths,
  isRecord,
  processAlive,
  readReply,
  readSnapshot,
  resolveInstanceId,
  runSync,
  type Answer,
  type Snapshot,
} from "./index.ts";

const ID = "aoe.opencode.tui";
const DEBUG = () => process.env.AOE_OPENCODE_DEBUG === "1";

function log(message: string): void {
  if (DEBUG()) console.error(`[aoe-opencode-tui] ${message}`);
}

export type FormOption = { value: string; label: string };

export type FormField = {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external";
  title?: string;
  required?: boolean;
  hidden?: boolean;
  when?: { key: string; op: "eq" | "neq"; value: string | number | boolean }[];
  options?: FormOption[];
  custom?: boolean;
};

export type Form = { id: string; sessionID: string; fields: FormField[] };

export type FormReply = {
  sessionID: string;
  formID: string;
  answer: Record<string, string | number | boolean | string[]>;
};

export type TuiContext = {
  data: {
    session: {
      form: {
        list(sessionID: string): Form[] | undefined;
        sync(sessionID: string, location?: unknown): Promise<void>;
        reply(input: FormReply, location?: unknown): Promise<void>;
      };
    };
  };
};

function sameScalar(left: unknown, right: unknown): boolean {
  if (typeof left === "object" || typeof right === "object") return false;
  return String(left) === String(right);
}

/// A conditional field applies when every `when` clause holds for the answers
/// collected so far. Unanswered keys leave the field included rather than
/// guessed away.
export function applies(field: FormField, answers: Record<string, unknown>): boolean {
  for (const condition of field.when ?? []) {
    if (!(condition.key in answers)) continue;
    const equal = sameScalar(answers[condition.key], condition.value);
    if (condition.op === "eq" ? !equal : equal) return false;
  }
  return true;
}

/// Translate one AoE answer into the value the form field declares. Option
/// labels stand for their values, and a custom answer becomes the typed value.
function answerValue(answer: Answer, field: FormField): FormReply["answer"][string] | undefined {
  const selected = answer.selected_options;
  const custom = answer.custom_input?.trim();
  const options = field.options ?? [];
  switch (field.type) {
    case "multiselect": {
      const values: string[] = [];
      for (const label of selected) {
        const option = options.find((entry) => entry.label === label);
        if (!option) return undefined;
        values.push(option.value);
      }
      if (custom) values.push(custom);
      return values;
    }
    case "boolean": {
      const word = (custom ?? selected[0] ?? "").trim().toLowerCase();
      if (["true", "yes", "1", "on"].includes(word)) return true;
      if (["false", "no", "0", "off"].includes(word)) return false;
      return undefined;
    }
    case "number":
    case "integer": {
      const raw = custom ?? selected[0];
      if (raw === undefined) return undefined;
      const value = Number(raw);
      if (!Number.isFinite(value)) return undefined;
      return field.type === "integer" ? Math.trunc(value) : value;
    }
    default: {
      if (selected.length === 1) {
        const option = options.find((entry) => entry.label === selected[0]);
        if (option) return option.value;
        return selected[0];
      }
      if (custom) return custom;
      return undefined;
    }
  }
}

/// Build the form reply for the prompt a snapshot publishes. A form this part
/// cannot map completely leaves the prompt to OpenCode instead of submitting a
/// partial answer.
export function planFormReply(snapshot: Snapshot, form: Form, answers: Answer[]): FormReply | undefined {
  const prompt = snapshot.prompt;
  if (!prompt || prompt.kind !== "question") return undefined;
  if (form.sessionID !== snapshot.provider_session_id || prompt.id !== form.id) return undefined;
  const values: FormReply["answer"] = {};
  for (const field of form.fields) {
    if (field.hidden || field.type === "external") continue;
    if (!applies(field, values)) continue;
    const answer = answers.find((entry) => entry.id === field.key);
    if (!answer) {
      if (field.required) return undefined;
      continue;
    }
    const value = answerValue(answer, field);
    if (value === undefined) {
      if (field.required) return undefined;
      continue;
    }
    values[field.key] = value;
  }
  return { sessionID: form.sessionID, formID: form.id, answer: values };
}

export type RelayOptions = {
  context: TuiContext;
  instanceId: string;
  directory: string;
  uid?: number;
  pollMs?: number;
  log?: (message: string) => void;
};

export type Relay = {
  pollOnce(): Promise<boolean>;
  start(): void;
  stop(): void;
};

export function createFormRelay(options: RelayOptions): Relay {
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const report = options.log ?? (() => {});
  const attempted = new Set<string>();
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const pollOnce = async (): Promise<boolean> => {
    if (inFlight) return false;
    inFlight = true;
    try {
      const snapshot = readSnapshot(options.directory, uid, options.instanceId);
      if (!snapshot || !snapshot.prompt || snapshot.prompt.kind !== "question") return false;
      if (!processAlive(snapshot.writer_pid)) return false;
      const reply = readReply(options.directory, uid, snapshot);
      // Approval replies belong to the server part; only question answers land here.
      if (!reply || reply.response.kind !== "question") return false;
      if (attempted.has(reply.response_id)) return false;
      const sessionID = snapshot.provider_session_id;
      let forms = options.context.data.session.form.list(sessionID);
      if (forms === undefined) {
        await options.context.data.session.form.sync(sessionID);
        forms = options.context.data.session.form.list(sessionID);
      }
      const form = forms?.find((entry) => entry.id === snapshot.prompt?.id);
      // A form the TUI has not synced yet is retried on the next tick.
      if (!form) return false;
      const plan = planFormReply(snapshot, form, reply.response.answers);
      if (!plan) {
        report(`could not map the reply onto form ${form.id}; answer it in OpenCode`);
        return false;
      }
      attempted.add(reply.response_id);
      try {
        await options.context.data.session.form.reply(plan);
      } catch (error) {
        report(`could not answer form ${form.id}: ${String(error)}`);
      }
      try {
        await unlink(path.join(options.directory, REPLY_NAME));
      } catch {
        // The host replaces the file on the next response either way.
      }
      return true;
    } catch (error) {
      report(`could not read the report: ${String(error)}`);
      return false;
    } finally {
      inFlight = false;
    }
  };

  return {
    pollOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void pollOnce().catch(() => {});
      }, options.pollMs ?? REPLY_POLL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

async function setup(context: TuiContext): Promise<(() => void) | undefined> {
  const instanceId = resolveInstanceId(process.env, runSync);
  if (!instanceId) return undefined;
  const form = context?.data?.session?.form;
  if (!isRecord(form) || typeof form.list !== "function" || typeof form.reply !== "function") {
    log("this OpenCode build exposes no form API; leaving forms to OpenCode");
    return undefined;
  }
  const uid = process.getuid?.() ?? 0;
  const { dir: directory } = integrationPaths(process.env, uid, instanceId);
  const relay = createFormRelay({ context, instanceId, directory, uid, log });
  log(`watching form prompts in ${directory}`);
  relay.start();
  return () => relay.stop();
}

export default { id: ID, setup };
