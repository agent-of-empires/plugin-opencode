# OpenCode integration for Agent of Empires

Provider-native OpenCode session status and explicit approval/question replies
in AoE's session list. This repository contains two independently installed
artifacts, the same split the paired OMP integration uses:

- `aoe-plugin.toml` is the AoE plugin manifest. From a checkout, install it with
  `aoe plugin install --dev .` and approve its `session.integration` capability
  through AoE's normal install flow. The id sits in the reserved
  `agent-of-empires.*` namespace, so a plain `aoe plugin install` or a `gh:`
  install is refused until core's featured index pins a release of this
  repository.
- `opencode-extension/index.ts` is the provider-native OpenCode plugin. It is
  loaded inside OpenCode and observes OpenCode's own event bus.

Neither artifact configures the other. Install both, and restart OpenCode after
installing the extension: a running OpenCode process does not load a plugin it
did not start with.

## Supported OpenCode versions

The manifest declares two provider ranges, and the extension enforces the same
ranges before it activates:

| Range | Notes |
| --- | --- |
| `>=1.18.29, <2.0.0` | OpenCode 1.x loads the default export's `server()`, and answers permissions through the server's reply routes. |
| `>=2.0.0-0, <3.0.0` | OpenCode 2.x loads `setup(ctx)`, subscribes to the event bus, and replies to permissions through `ctx.permission.reply`. Questions are forms there, so the TUI part answers those through `context.data.session.form.reply`. 2.x is still in beta; the plugin API may change, and a compatible extension release will be published when it does. V2 has no combined status event, so the extension maps the execution lifecycle (`session.execution.started` and its terminal events) onto AoE's statuses. |

Prereleases are excluded from the 1.x range and included in the 2.x range.
OpenCode 1.18.28 and earlier and OpenCode 3.x are not supported.

One entrypoint serves both generations: OpenCode 1.x calls the default export's
`server()`, and OpenCode 2.x calls `setup()`. One classifier serves them: V1
carries event fields under `properties`, V2 under `data`, and V2 names its
lifecycle events differently, so the classifier translates both.

### Verified builds

OpenCode `1.19.6` (`serve`) was verified live with a permission rule asking for
`bash`: the extension published `waiting` with the approval prompt, an AoE `allow`
reply ran the command and cleared the prompt, and an AoE `deny` reply left the
tool failed without running it. That build loads the default export's `server()`
and reads its `plugin` config key with a file path.

OpenCode `2.3.0` (`serve`) was verified the same way: `setup(ctx)` loaded, the
extension published `running`/`idle` from the execution lifecycle, published
`waiting` with a `permission.asked` prompt, and an AoE `allow` reply delivered
through `ctx.permission.reply` ran the command.

The 2.3.0 TUI part is verified only up to loading: its module shape matches the
TUI loader's check, OpenCode resolves `<plugin directory>/tui` as the TUI
entrypoint, and the form relay is covered by the tests against a recorded form
shape. A live 2.x form has not been answered end to end: that needs a running
2.x TUI, and the 2.3.0 TUI blocks at its terminal handshake in a headless tmux
pane.

Only these builds were exercised. Earlier 1.x releases share the V1 hook shape,
and other 2.x betas may rename events before the API stabilizes.

### Unsupported versions and missing plugins

On an unsupported version the extension logs one line naming the running
version and the supported ranges, publishes status only (no prompts, no reply
keys), and calls no reply route. OpenCode keeps its own prompts and keymap.
AoE treats a report whose `provider_version` is outside the declared ranges as
unsupported, leaves the session to its pane rules, and logs the reported
version and declared ranges, so status stays visible instead of turning into an
owned `Unknown`. The status-only report is what lets the host read that version
and say why it stepped aside.

While the extension or the AoE plugin is missing, disabled, or unapproved, pane
detection remains the status source. A missing report is not an invalid one: the
host keeps the session's pane status until the extension publishes, so
installing the AoE plugin before the extension does not blank status.

## Install

### OpenCode extension

OpenCode 1.x and 2.x both discover direct files in the plugin directory, and
OpenCode 2.x resolves a plugin's `tui` entrypoint only through a plugin
directory. Install both files as one directory:

```sh
mkdir -p ~/.config/opencode/plugins/aoe-status
cp opencode-extension/index.ts opencode-extension/tui.ts ~/.config/opencode/plugins/aoe-status/
```

`index.ts` is the server part; `tui.ts` is the TUI part OpenCode loads beside
it. A single-file copy (`aoe-status.ts`) still reports status and answers
permissions and 1.x questions, but OpenCode 2 forms then stay in OpenCode,
because only the TUI part can reply to one. See
[OpenCode plugins](https://opencode.ai/docs/plugins/) for package-based installs.

### AoE plugin

```sh
aoe plugin install --dev .
aoe plugin list
```

Updates that change the manifest's agent integration require approval again;
removals alone do not.

## Behavior

The extension publishes schema-1 provider snapshots to the session's private
hook directory, `/tmp/aoe-hooks-<euid>/<instance id>/integration-agent-of-empires.opencode.json`:

| OpenCode event | AoE status | Prompt |
| --- | --- | --- |
| `session.status` `busy`/`active`/`running`/`streaming`/`retry`/`pending`/`working` | Running | |
| `session.status` `idle`, `session.idle` | Idle | |
| `permission.asked` | Waiting | Approval, with `allow_always` when OpenCode offers saved approvals |
| `question.asked` | Waiting | Question, one entry per asked question |
| `form.created` | Waiting | Question, one entry per form field |
| `form.replied`, `form.cancelled` | Running | Prompt cleared |
| `permission.replied`, `question.replied`, `question.rejected` | Running | Prompt cleared |
| `tool.execute.before`/`after`, `chat.message`, `session.compacted` | Running | |
| `session.error` | Error | |
| child (subagent) session status | ignored | Prompts raised there are still answerable |

Snapshots carry the live writer PID, a revision that changes only when the
prompt changes, and `F12` as the only wake key. The extension rewrites the
snapshot every 5 seconds so AoE's 15-second freshness window keeps holding.

In AoE's session list, select the OpenCode session and press `a` to open the
approval or question dialog. AoE validates the reply against the current
snapshot, writes it to `integration-agent-of-empires.opencode.reply.json`, and
sends the declared wake key. The extension reads the reply, commits it through
OpenCode's own reply API, removes the reply file, and publishes the resulting
Running state. A reply for an older revision or an already-consumed prompt is
ignored.

Replies commit the same semantic decision that OpenCode's configured permission
keymap commits (`once`, `always`, `reject`, or the selected labels), through
OpenCode's reply routes rather than synthesized keystrokes. A custom question
answer is sent as an extra label after the selected options.

OpenCode remains the approval authority. This extension does not intercept tool
execution, approve calls on AoE's behalf, or change OpenCode's ruleset. If
reporting or reply delivery fails, OpenCode's native prompt stays available.

OpenCode 2.x asks through forms, not questions. The server context has no form
API, so the server part publishes the form as an AoE question prompt and leaves
the AoE reply on disk; the TUI part reads it, maps the selected labels back onto
the form's option values, and submits the answer through
`context.data.session.form.reply`. Without the TUI part (or when the form is
missing or cannot be mapped completely) the prompt is published but must be
answered in OpenCode.

## Development

```sh
bun test tests
```

The tests cover the version gate, event classification, prompt mapping, reply
validation and application, report file hardening, and the unsupported-version
path. They run without an OpenCode install.

Live runs were driven with a local OpenAI-compatible stub model that asks for
one `bash` command, so a permission prompt can be produced without provider
credentials. Both verified builds are recorded above; rerun the same way against
a new OpenCode release before widening the declared ranges.

## License

MIT
