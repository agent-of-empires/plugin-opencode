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
| `>=2.0.0-0, <3.0.0` | OpenCode 2.x loads `setup(ctx)`, subscribes to the event bus, and replies through `ctx.permission.reply`. 2.x is still in beta; the plugin API may change, and a compatible extension release will be published when it does. |

Prereleases are excluded from the 1.x range and included in the 2.x range.
OpenCode 1.18.28 and earlier and OpenCode 3.x are not supported.

One entrypoint serves both generations: OpenCode 1.x calls the default export's
`server()`, and OpenCode 2.x calls `setup()`. Both read the event shape
`{ type, properties }`, so a single classifier serves them.

### Verified builds

Status was verified live against OpenCode `1.19.6` (`serve`, real
`session.created`, `session.status` and `session.idle` events, report published
and consumed by the host). That build loads the default export's `server()` and
reads its `plugin` config key with a file path. Reply delivery is covered by the
extension's tests against OpenCode's reply routes; it has not been exercised
against a live permission prompt, and OpenCode 2.x has not been run live at all.
Both remain unproven until someone drives them with a configured model.

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

OpenCode 1.x and 2.x both discover direct files in the plugin directory:

```sh
mkdir -p ~/.config/opencode/plugins
cp opencode-extension/index.ts ~/.config/opencode/plugins/aoe-status.ts
```

A configured plugin path must be a directory, so a single-file copy under the
discovered `plugins/` directory is the portable option. See
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

OpenCode 2.x question replies need a `ctx.question.reply` API, which the current
2.x beta does not document. When that API is absent the extension publishes the
question but refuses the reply with a logged reason, and the prompt must be
answered in OpenCode.

## Development

```sh
bun test tests
```

The tests cover the version gate, event classification, prompt mapping, reply
validation and application, report file hardening, and the unsupported-version
path. They run without an OpenCode install.

Live verification against a real OpenCode release is still outstanding: no
supported OpenCode build is installed in the development environment this
integration was written in, so status parity with pane detection and reply
delivery have not been exercised end to end. Run both artifacts against
OpenCode 1.18.x and a 2.x beta before pinning a featured release.

## License

MIT
