import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

/**
 * AWS SSO auto-refresh for omp.
 *
 * Mirrors Claude Code's `awsAuthRefresh`: before each agent turn, check
 * whether AWS credentials are still valid; if not, run a configured refresh
 * command (e.g. `aws sso login --sso-session <name>`), block until it
 * completes, then continue. This PREVENTS the mid-turn SigV4 signing failure
 * that omp's bedrock credential resolver throws on an expired SSO token,
 * rather than trying to recover from it — the extension event surface has no
 * hook that can resume a turn that already errored out.
 *
 * Validity check:
 *   - SSO profiles (an `sso_session` on the active AWS_PROFILE): read the
 *     token expiry straight from the CLI's own cache —
 *     `~/.aws/sso/cache/<sha1(session-name)>.json` — and compare `expiresAt`
 *     to now. This is exactly the file AWS CLI v2 / botocore key by, so it is
 *     zero-network and has no staleness window: every turn sees the true
 *     expiry. A small skew triggers the refresh slightly early so a long turn
 *     never crosses the boundary mid-stream.
 *   - Non-SSO profiles (static keys, credential_process, role chains): no
 *     local expiry to read, so fall back to an `aws sts get-caller-identity`
 *     probe, throttled to at most once per PROBE_TTL_MS to avoid taxing every
 *     turn.
 *
 * Refresh-command resolution order:
 *   1. `awsAuthRefresh` key in ~/.omp/agent/config.yml (verbatim, like Claude Code)
 *   2. derived `aws sso login --sso-session <session>`, where <session> is the
 *      sso_session of the active AWS_PROFILE in ~/.aws/config
 *   3. notify-only if neither is available
 */

const OMP_CONFIG_PATH = join(homedir(), ".omp", "agent", "config.yml");
const AWS_CONFIG_PATH = process.env.AWS_CONFIG_FILE || join(homedir(), ".aws", "config");
const AWS_SSO_CACHE_DIR = join(homedir(), ".aws", "sso", "cache");

/** Treat an SSO token as expired this long before its real `expiresAt`, so a
 *  long turn started just under the wire does not expire mid-stream. */
const EXPIRY_SKEW_MS = 60_000;

/** Throttle for the non-SSO fallback `sts` probe (the SSO path is local/cheap). */
const PROBE_TTL_MS = 60_000;

/** Read the `awsAuthRefresh:` top-level scalar from config.yml without a YAML dep. */
function configuredRefreshCommand(): string | undefined {
  try {
    const text = readFileSync(OMP_CONFIG_PATH, "utf8");
    const m = text.match(/^awsAuthRefresh:\s*(.+?)\s*$/m);
    if (!m) return undefined;
    return m[1].replace(/^["']|["']$/g, "").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Read a single `key = value` from an INI section (e.g. `[profile foo]`) in ~/.aws/config. */
function awsConfigValue(header: string, key: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(AWS_CONFIG_PATH, "utf8");
  } catch {
    return undefined;
  }
  let inSection = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inSection = line === header;
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf("=");
    if (eq !== -1 && line.slice(0, eq).trim() === key) return line.slice(eq + 1).trim();
  }
  return undefined;
}

/** The `sso_session` name of the active AWS_PROFILE, or undefined for a non-SSO profile. */
function activeSsoSession(): string | undefined {
  const profile = process.env.AWS_PROFILE || "default";
  const header = profile === "default" ? "[default]" : `[profile ${profile}]`;
  return awsConfigValue(header, "sso_session");
}

/** Epoch-ms expiry of the cached SSO token for `session`, or undefined when no
 *  usable token is cached. The CLI keys the cache by sha1 of the session name. */
function ssoTokenExpiryMs(session: string): number | undefined {
  const file = join(AWS_SSO_CACHE_DIR, `${createHash("sha1").update(session).digest("hex")}.json`);
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { accessToken?: unknown; expiresAt?: unknown };
    if (!data.accessToken || typeof data.expiresAt !== "string") return undefined;
    const t = Date.parse(data.expiresAt);
    return Number.isNaN(t) ? undefined : t;
  } catch {
    return undefined;
  }
}

/** True when `session`'s cached SSO token exists and is not within the skew of expiry. */
function ssoTokenValid(session: string): boolean {
  const expiry = ssoTokenExpiryMs(session);
  return expiry !== undefined && Date.now() + EXPIRY_SKEW_MS < expiry;
}

export default function awsSsoRefresh(pi: ExtensionAPI): void {
  // Last time the non-SSO `sts` probe ran (epoch ms); unused on the SSO path.
  let lastProbeAt = 0;

  // pi.exec(program, argsArray, opts) spreads argsArray into [program, ...args];
  // it does NOT accept a single command string. Tokenize on whitespace (these
  // commands have no quoted args) and split program from args.
  async function run(command: string): Promise<void> {
    const [program, ...args] = command.split(/\s+/).filter(Boolean);
    await pi.exec(program, args);
  }

  // get-caller-identity exercises the same credential chain Bedrock signs with;
  // exit 0 = resolvable & unexpired, non-zero = needs refresh.
  async function probeValid(): Promise<boolean> {
    try {
      await run("aws sts get-caller-identity");
      return true;
    } catch {
      return false;
    }
  }

  pi.on("before_agent_start", async (_event, ctx) => {
    const session = activeSsoSession();

    if (session) {
      // SSO: exact, zero-network expiry read — checked every turn.
      if (ssoTokenValid(session)) return;
    } else {
      // Non-SSO: no local expiry to read; fall back to a throttled probe.
      if (Date.now() - lastProbeAt < PROBE_TTL_MS) return;
      lastProbeAt = Date.now();
      if (await probeValid()) return;
    }

    const command = configuredRefreshCommand() ?? (session ? `aws sso login --sso-session ${session}` : undefined);
    if (!command) {
      ctx.ui.notify(
        "AWS credentials expired and no refresh command found. Set `awsAuthRefresh` in config.yml or an sso_session on your AWS_PROFILE, then run `aws sso login`.",
        "warning",
      );
      return;
    }

    ctx.ui.notify(`AWS credentials expired — running: ${command}`, "info");
    try {
      await run(command);
    } catch (err) {
      ctx.ui.notify(
        `AWS refresh command failed (${command}): ${err instanceof Error ? err.message : String(err)}`,
        "warning",
      );
      return;
    }

    // Re-confirm via the same signal we used to detect the lapse.
    let ok: boolean;
    if (session) {
      ok = ssoTokenValid(session);
    } else {
      lastProbeAt = Date.now();
      ok = await probeValid();
    }
    ctx.ui.notify(
      ok ? "AWS credentials refreshed." : "AWS refresh ran but credentials still invalid.",
      ok ? "info" : "warning",
    );
  });
}
