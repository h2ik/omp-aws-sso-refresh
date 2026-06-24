# omp-aws-sso-refresh

Auto-refresh AWS SSO credentials before each [oh-my-pi](https://github.com/can1357/oh-my-pi) turn — the equivalent of Claude Code's `awsAuthRefresh`, for omp.

When you run Bedrock models through AWS SSO, the SSO token expires every few hours. Once it does, the next turn dies mid-stream with a SigV4 signing error (`AWS SSO token ... has expired. Run 'aws sso login'`). This extension checks credential validity *before* the turn and runs your login command if they've lapsed — so the turn never fails.

## Why proactive, not reactive

omp's extension events (`auto_retry_start`, `credential_disabled`) are notification-only — none can catch the mid-stream credential throw and resume the failed turn. So this prevents the expiry instead of recovering from it: probe on `before_agent_start`, refresh if stale, then proceed. True in-flight retry would need an upstream change in omp's bedrock signing path.

## How it works

On `before_agent_start` (cached per process — one probe per cold start, re-probed only after a refresh):

1. Probe `aws sts get-caller-identity` — the same credential chain Bedrock signs with. Exit 0 = valid, skip. Non-zero = refresh.
2. Resolve a refresh command:
   - `awsAuthRefresh` key in `~/.omp/agent/config.yml` (verbatim, like Claude Code), else
   - derived `aws sso login --sso-session <session>` from the `sso_session` of your active `AWS_PROFILE` in `~/.aws/config`, else
   - notify-only.
3. Run it (blocking — the browser SSO flow completes before the turn proceeds), re-probe, continue.

## Install

```sh
omp plugin install github:h2ik/omp-aws-sso-refresh
```

Local development:

```sh
omp plugin link /path/to/omp-aws-sso-refresh
```

## Configuration

Optional — by default it derives the command from your active `AWS_PROFILE`. To pin an explicit command, add to `~/.omp/agent/config.yml`:

```yaml
awsAuthRefresh: aws sso login --sso-session my-session
```

## Requirements

- The AWS CLI on `PATH`.
- An `AWS_PROFILE` with an `sso_session` in `~/.aws/config`, or an explicit `awsAuthRefresh` command.
