import { Command } from "commander";
import { resolve } from "node:path";
import { client } from "../http";
import { getActiveProjectId, type GlobalOptions } from "../config";
import { revealKey, type ApiKeyDTO } from "./keys";
import {
  buildEnvContent,
  mergeEnvContent,
  readEnvFile,
  writeEnvFile,
} from "../env-file";
import { restoreDotenvFiles } from "../run-env";
import { resolveEnvironment } from "../service-identity";
import { printJson, printSuccess, dim, yellow, reportError } from "../ui/format";

interface ExportOpts extends GlobalOptions {
  env?: string;
  output?: string;
  vaultKey?: string;
  force?: boolean;
}

interface RestoreOpts {
  directory?: string;
}

/**
 * apivault env export — decrypt keys for an environment and write them to a
 * local .env file (merge by default; --force replaces the file).
 */
async function exportEnv(opts: ExportOpts, json: boolean): Promise<void> {
  const env = await resolveEnvironment(opts.env);

  const projectId = getActiveProjectId(opts.project);
  const output = (opts.output ?? ".env").trim() || ".env";

  const params = new URLSearchParams();
  params.set("environment", env);
  const keys = await client.request<ApiKeyDTO[]>(`/api/keys?${params.toString()}`, { projectId });

  if (!keys || keys.length === 0) {
    throw new Error(`No keys found for environment "${env}".`);
  }

  const secrets: Record<string, string> = {};
  for (const k of keys) {
    secrets[k.name] = await revealKey(client, k.id, opts.vaultKey, projectId);
  }

  const existing = opts.force ? "" : readEnvFile(output);
  const content = opts.force ? buildEnvContent(secrets) : mergeEnvContent(existing, secrets);
  writeEnvFile(output, content);

  if (json) {
    printJson({
      environment: env,
      output,
      keys: Object.keys(secrets).sort(),
      merged: !opts.force,
    });
    return;
  }

  printSuccess(
    `Wrote ${keys.length} secret${keys.length === 1 ? "" : "s"} to ${output}` +
      (opts.force ? " (replaced)." : " (merged)."),
    json,
  );
  process.stdout.write(
    yellow("⚠ ") +
      dim("This file contains secrets. Keep it out of version control (add to .gitignore).\n"),
  );
}

/**
 * apivault env restore — rename dotenv backups created by `apivault run`
 * back to their original filenames.
 */
async function restoreEnv(opts: RestoreOpts, json: boolean): Promise<void> {
  const dir = resolve(opts.directory ?? process.cwd());
  const restored = restoreDotenvFiles(dir);

  if (json) {
    printJson({ directory: dir, restored });
    return;
  }

  if (restored.length === 0) {
    process.stdout.write(dim(`No hidden dotenv files found in ${dir}.\n`));
    return;
  }

  printSuccess(
    `Restored ${restored.length} dotenv file${restored.length === 1 ? "" : "s"}: ${restored.join(", ")}`,
    json,
  );
}

/** Register the `env` command group on the parent program. */
export function registerEnvCommand(program: Command): void {
  const globals = () => program.opts() as GlobalOptions;
  const json = () => Boolean(globals().json);
  const handle = (err: unknown) => {
    reportError(err, json());
    process.exitCode = 1;
  };

  const env = program
    .command("env")
    .description("Export vault secrets to or restore local .env files");

  env
    .command("export")
    .description("Decrypt keys for an environment and save them to a .env file")
    .option("--env <environment>", "Environment to export (or set config run.env)")
    .option("-o, --output <file>", "Output path (default: .env)", ".env")
    .option(
      "--vault-key <vaultKey>",
      "Vault key for projects in custom encryption mode (or set APIVAULT_KEY)",
    )
    .option("-f, --force", "Replace the file instead of merging with existing variables")
    .action(async (opts: ExportOpts) => exportEnv({ ...globals(), ...opts }, json()).catch(handle));

  env
    .command("restore")
    .description("Restore dotenv files moved aside by `apivault run`")
    .option("-C, --directory <dir>", "Project directory (default: current working directory)")
    .action(async (opts: RestoreOpts) => restoreEnv(opts, json()).catch(handle));
}
