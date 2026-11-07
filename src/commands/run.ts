import type { ChildProcess } from "node:child_process";
import { constants } from "node:os";
import spawn from "cross-spawn";
import { Command } from "commander";
import { client } from "../http";
import { revealKey, type ApiKeyDTO } from "./keys";
import { getConfigValue, getActiveProjectId, type GlobalOptions } from "../config";
import { buildRunEnv, hideDotenvFiles, restoreDotenvFiles } from "../run-env";
import { resolveEnvironment } from "../service-identity";
import { green, dim, yellow, reportError } from "../ui/format";

interface RunOpts extends GlobalOptions {
  /** Environment to load secrets from. Falls back to config `run.env`. */
  env?: string;
  /** Vault key for custom-mode accounts. */
  vaultKey?: string;
}

/**
 * Split a command string into tokens, respecting double-quoted segments so
 * `npm run "my build"` splits as ["npm", "run", "my build"].
 */
function splitCommand(cmd: string): string[] {
  const matches = cmd.match(/(?:[^\s"]+|"[^"]*")+/g);
  if (!matches) return [];
  return matches.map((s) => s.replace(/^"|"$/g, ""));
}

/** Conventional shell exit code for a process terminated by `signal`. */
function exitCodeForSignal(signal: string): number {
  const n = constants.signals[signal as keyof typeof constants.signals];
  return typeof n === "number" ? 128 + n : 128;
}

/**
 * apivault run [--env <env>] [--vault-key <vaultKey>] [-- <command> [args...]]
 *
 * Env and command resolve with explicit flags first, then fall back to the
 * local config (`run.env`, `run.command`). Loads all secrets for the env,
 * injects them into the child environment, and spawns the command. Local
 * dotenv files (.env, .env.local, etc.) are ignored so vault secrets are
 * the only source of configuration values.
 */
async function runCommand(opts: RunOpts, commandAndArgs: string[]): Promise<void> {
  // --- Resolve environment: --env flag → service token pin → config run.env.
  const env = await resolveEnvironment(opts.env);

  // --- Resolve command: explicit `--` args → config run.command → error.
  let command = commandAndArgs;
  if (!command.length) {
    const configured = getConfigValue("run.command");
    if (configured) {
      command = splitCommand(configured);
    }
  }
  if (!command.length) {
    throw new Error(
      "No command specified. Pass `-- <command> [args...]`, or set a default with `apivault config set run.command \"<command>\"`.",
    );
  }

  const c = client;
  const projectId = getActiveProjectId(opts.project);

  // 1. Fetch keys filtered by environment (server-side).
  const params = new URLSearchParams();
  params.set("environment", env);
  const keys = await c.request<ApiKeyDTO[]>(`/api/keys?${params.toString()}`, { projectId });

  const envOverlay: Record<string, string> = {};

  if (!keys || keys.length === 0) {
    process.stdout.write(
      yellow("⚠ ") +
        dim(`No keys found for environment "${env}". Running without injected secrets.\n`),
    );
  } else {
    // 2. Decrypt each key and build the env overlay.
    for (const k of keys) {
      const rawValue = await revealKey(c, k.id, opts.vaultKey, projectId);
      envOverlay[k.name] = rawValue;
    }

    process.stdout.write(
      green("→ ") +
        `${keys.length} secret${keys.length === 1 ? "" : "s"} loaded for the child process\n`,
    );
  }

  const childEnv = buildRunEnv(envOverlay);
  const projectDir = process.cwd();
  const hiddenDotenvFiles = hideDotenvFiles(projectDir);
  if (hiddenDotenvFiles.length > 0) {
    process.stdout.write(
      dim(
        `Local dotenv file${hiddenDotenvFiles.length === 1 ? "" : "s"} moved aside: ${hiddenDotenvFiles.join(", ")}\n`,
      ),
    );
  }

  // Best-effort restore of dotenv files. Safe to call multiple times — if
  // files have already been restored (or were never hidden), it's a no-op.
  let restored = false;
  const restoreDotenv = () => {
    if (restored) return;
    restored = true;
    try {
      const files = restoreDotenvFiles(projectDir);
      if (files.length > 0) {
        process.stdout.write(
          dim(
            `\nRestored dotenv file${files.length === 1 ? "" : "s"}: ${files.join(", ")}\n`,
          ),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        yellow("⚠ ") +
          dim(`Could not restore dotenv files (run \`apivault env restore\`): ${message}\n`),
      );
    }
  };

  let child: ChildProcess | undefined;

  const cleanupParentHandlers = () => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  };

  // Restore dotenv files if the parent is interrupted before the child exits.
  const onParentSignal = (signal: NodeJS.Signals) => {
    child?.kill();
    restoreDotenv();
    cleanupParentHandlers();
    process.exit(exitCodeForSignal(signal));
  };
  const onSigint = () => onParentSignal("SIGINT");
  const onSigterm = () => onParentSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  // 3. Spawn the child command. cross-spawn resolves .cmd/.bat on Windows
  //    (so `npm` etc. work) without a shell, avoiding Node's DEP0190 and
  //    escaping args correctly.
  const [cmd, ...args] = command;
  child = spawn(cmd, args, {
    stdio: "inherit",
    env: childEnv,
    cwd: projectDir,
  });
  const spawned = child;

  return new Promise<void>((resolve) => {
    spawned.on("close", (code, signal) => {
      cleanupParentHandlers();
      restoreDotenv();

      if (code !== null && code !== 0) {
        process.exitCode = code;
      } else if (code === null && signal) {
        process.exitCode = exitCodeForSignal(signal);
      }
      resolve();
    });

    spawned.on("error", (err) => {
      cleanupParentHandlers();
      restoreDotenv();

      reportError(err, false);
      process.exitCode = 1;
      resolve();
    });
  });
}

/** Register the `run` command on the parent program. */
export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("Inject vault secrets and run a command (local .env files are ignored)")
    .option("--env <environment>", "Environment to load secrets from (or set config run.env)")
    .option(
      "--vault-key <vaultKey>",
      "Vault key for projects in custom encryption mode (or set APIVAULT_KEY)",
    )
    .allowUnknownOption(true)
    .action(async (localOpts: RunOpts, cmd: Command) => {
      const opts = { ...(program.opts() as GlobalOptions), ...localOpts };
      // Prefer an explicit `--` separator, which survives option parsing
      // everywhere. Fall back to Commander's remaining operands for shells
      // (e.g. PowerShell) that strip `--` before native commands see it.
      const separatorIdx = process.argv.indexOf("--");
      const commandAndArgs =
        separatorIdx !== -1
          ? process.argv.slice(separatorIdx + 1)
          : cmd.args;
      return runCommand(opts, commandAndArgs).catch((err) => {
        reportError(err, false);
        process.exitCode = 1;
      });
    });
}
