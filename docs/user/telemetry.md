# Product usage data

The T3 Code server sends product usage events to PostHog, associated with a hashed account or
installation identifier. Events include the provider, model, reasoning effort, permission mode,
turn result, duration, and main-agent token totals when available.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

This fork collects nothing by default. To send events to a PostHog project you control, set
`T3CODE_TELEMETRY_ENABLED=true` and `T3CODE_POSTHOG_KEY` (plus `T3CODE_POSTHOG_HOST` for a
self-hosted PostHog) in the server's environment before starting it.

The desktop app reads the variable from your shell profile (for example `~/.zshrc`) on macOS and
Linux, so export it there and restart the app. On Windows, set it as a user environment variable.
