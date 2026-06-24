import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

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
 * Refresh-command resolution order:
 *   1. `awsAuthRefresh` key in ~/.omp/agent/config.yml (verbatim, like Claude Code)
 *   2. derived `aws sso login --sso-session <session>`, where <session> is the
 *      sso_session of the active AWS_PROFILE in ~/.aws/config
 *   3. notify-only if neither is available
 */

const OMP_CONFIG_PATH = join(homedir(), ".omp", "agent", "config.yml");
const AWS_CONFIG_PATH = process.env.AWS_CONFIG_FILE || join(homedir(), ".aws", "config");

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

/** Find the sso_session for the active profile in ~/.aws/config → a login command. */
function deriveSsoLoginCommand(): string | undefined {
  const profile = process.env.AWS_PROFILE || "default";
  let text: string;
  try {
    text = readFileSync(AWS_CONFIG_PATH, "utf8");
  } catch {
    return undefined;
  }
  const header = profile === "default" ? "[default]" : `[profile ${profile}]`;
  let inSection = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inSection = line === header;
      continue;
    }
    if (inSection) {
      const m = line.match(/^sso_session\s*=\s*(.+)$/);
      if (m) return `aws sso login --sso-session ${m[1].trim()}`;
    }
  }
  return undefined;
}

export default function awsSsoRefresh(pi: ExtensionAPI): void {
  // Cache the "creds are good" verdict for the process; re-probe only after a
  // turn where we believed they were bad, or once per cold start.
  let knownValid = false;

  async function credsValid(): Promise<boolean> {
    try {
      // get-caller-identity exercises the same credential chain Bedrock signs
      // with; exit 0 = resolvable & unexpired, non-zero = needs refresh.
      await pi.exec("aws sts get-caller-identity");
      return true;
    } catch {
      return false;
    }
  }

  pi.on("before_agent_start", async (_event, ctx) => {
    if (knownValid) return;

    if (await credsValid()) {
      knownValid = true;
      return;
    }

    const command = configuredRefreshCommand() ?? deriveSsoLoginCommand();
    if (!command) {
      ctx.ui.notify(
        "AWS credentials expired and no refresh command found. Set `awsAuthRefresh` in config.yml or an sso_session on your AWS_PROFILE, then run `aws sso login`.",
        "warn",
      );
      return;
    }

    ctx.ui.notify(`AWS credentials expired — running: ${command}`, "info");
    try {
      await pi.exec(command);
    } catch (err) {
      ctx.ui.notify(
        `AWS refresh command failed (${command}): ${err instanceof Error ? err.message : String(err)}`,
        "warn",
      );
      return;
    }

    if (await credsValid()) {
      knownValid = true;
      ctx.ui.notify("AWS credentials refreshed.", "info");
    } else {
      ctx.ui.notify("AWS refresh ran but credentials still invalid.", "warn");
    }
  });
}
