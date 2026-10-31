# hook-watch

A Claude Code mod that shows **how often each of your hooks fires** and **exactly what each model-calling hook costs**: prompt hooks and agent hooks, one by one, even when several share an event.

It reads Claude Code's own telemetry records inside the session, so there is nothing to set up and nothing is sent anywhere.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install hook-watch --marketplace LKGilgamesh/hook-watch
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install hook-watch --marketplace LKGilgamesh/hook-watch
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `LKGilgamesh/hook-watch`, then Add plugin.

## What you get

- **Status line**: `hooks 42 fired · model hooks $0.0012`, plus `⚠ N` when a limitation is active.
- **`/hooks-log`**: prints the breakdown and opens the **Hooks** pane beside the chat:
  - **Model-calling hooks**: each one's total cost, times fired, model, and how often it answered ok / not ok.
  - **Hook groups** (`PreToolUse:Bash`, `Stop`, ...): times fired and how many hooks ran, settings and plugin hooks alike.
  - **Model calls outside hooks**: the conversation itself, prompt suggestions, away summaries and so on, for comparison.
  - **Recent model-hook calls**: a history naming the hook that ran each time.
  - A **Reset** button that clears the counters.
- A toast when a hook blocks something.

Give a prompt or agent hook a `statusMessage` in your settings and hook-watch uses it as the hook's title; otherwise it shows the start of the hook's prompt.

## How it works

Claude Code hands mods its telemetry records even when OpenTelemetry export is off:

- `hook_execution_start` / `hook_execution_complete`: each hook group firing.
- `api_request`: every model call, with its exact `cost_usd` and `query_source` (`hook_prompt`, `hook_agent`, ...).
- `api_request_body` / `api_response_body`: link each hook call to the hook that made it.

To tell hooks apart, hook-watch switches on `OTEL_LOG_RAW_API_BODIES` **only while hooks are running**, caps each body at 8 KB, hashes the hook's fixed prompt text (the part before `$ARGUMENTS`), and **strips the body from the record before it goes any further**. It keeps only the hash and a short label. Main-conversation requests are never logged for this.

The mod makes no network calls, reads and writes no files and starts no processes.

## Limitations

When per-hook attribution is unsafe or unavailable, hook-watch falls back to cost per hook group and **tells you why** (a toast once, then listed at the top of the pane and of `/hooks-log`):

| Situation | What happens |
| --- | --- |
| `OTEL_LOG_RAW_API_BODIES` is already set (e.g. your organization logs request bodies) | Left untouched, bodies not stripped; cost per hook group |
| An OpenTelemetry logs exporter is configured | Body logging stays off: hook commands inherit the variable, and a Claude Code they start could export request text; cost per hook group |
| Claude Code refuses the variable | Cost per hook group |
| A hook call arrives without its body | Its cost counts for the group (marked `*`) |
| Records carry no `query_source` (a privacy setting) | Calls can't be told apart; counted under "unknown" |
| A model has no known price (common behind an LLM gateway with its own model names) | Shows $0; an admin can set `modelPricing` in managed settings |
| Claude Code passes mods no hook telemetry | Nothing to show; you're told so |

Cases where the mod **does not run at all**, so it cannot warn you:

- Claude Code versions without hooks modules (mods are an early-access feature; built on 2.1.316).
- Managed settings with `allowManagedHooksOnly` or `disableAllHooks`.
- Managed settings whose `strictKnownMarketplaces` does not allow this repository.

Costs are Claude Code's own figures, the same ones `/cost` totals: estimates at list price, or at your organization's rates where `modelPricing` is set. They are not an invoice.

Built-in or managed plugins that sit above user plugins (for example on Team and Enterprise plans) receive telemetry records before hook-watch does.

## License

MIT
