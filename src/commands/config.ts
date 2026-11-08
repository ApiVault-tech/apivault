import { Command } from "commander";
import { password } from "@inquirer/prompts";
import {
  readGlobalConfig,
  readLocalConfig,
  getConfigValue,
  setConfigValue,
  deleteConfigValue,
  getActiveProjectId,
  writeLocalConfig,
  type StoredConfig,
  type ConfigScope,
} from "../config";
import {
  deleteLegacyVaultKey,
  hasLegacyVaultKey,
  parseEnvReference,
  resolveProject,
  vaultKeySecretName,
  type ProjectIdentity,
} from "../vault-key";
import { deleteSecret, getSecret, secretStoreName, setSecret } from "../secret-store";
import { printJson, printSuccess, dim, green, cyan, yellow, reportError } from "../ui/format";

/** Keys whose values are secrets and should be masked in overview output. */
const SECRET_KEYS = new Set(["vaultKey"]);

/**
 * Config keys `set` will accept. Prevents typos (e.g. `vaultkeys`) from
 * silently creating entries that the rest of the CLI never reads.
 */
const KNOWN_CONFIG_KEYS = ["run.command", "run.env", "vaultKey", "project"] as const;

interface ConfigScopeOptions {
  local?: boolean;
  global?: boolean;
}

/** Suggest known keys close to a typoed one (case-insensitive containment). */
function suggestKeys(typed: string): string[] {
  const needle = typed.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!needle) return [];
  return KNOWN_CONFIG_KEYS.filter((k) => {
    const hay = k.toLowerCase().replace(/[^a-z0-9]/g, "");
    return hay.includes(needle) || needle.includes(hay);
  });
}

/** Reject unknown config keys with a helpful, typo-aware message. */
function assertKnownKey(key: string): void {
  if ((KNOWN_CONFIG_KEYS as readonly string[]).includes(key)) return;
  const suggestions = suggestKeys(key);
  throw new Error(
    `Unknown config key "${key}". Valid keys: ${KNOWN_CONFIG_KEYS.join(", ")}.` +
      (suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""),
  );
}

/** Mask all but the last 2 characters of a secret. */
function maskValue(value: string): string {
  if (!value) return "•••••••";
  if (value.length <= 4) return "••••";
  return "•".repeat(Math.max(4, value.length - 2)) + value.slice(-2);
}

/** How a config value is shown: secrets masked, `${env:NAME}` references as written. */
function displayValue(key: string, value: string): string {
  if (!SECRET_KEYS.has(key) || parseEnvReference(value)) return value;
  return dim(maskValue(value));
}

/** Flatten a nested config into dot-path entries (sorted for stable display). */
function flattenConfig(
  config: StoredConfig,
  prefix = "",
): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const [k, v] of Object.entries(config)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(...flattenConfig(v as StoredConfig, path));
    } else if (typeof v === "string") {
      out.push({ key: path, value: v });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Right-pad a string to a given width. */
function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - s.length));
}

function resolveScopeOption(opts: ConfigScopeOptions): "local" | "global" | undefined {
  if (opts.local && opts.global) {
    throw new Error("Cannot specify both --local and --global at the same time.");
  }
  if (opts.local) return "local";
  if (opts.global) return "global";
  return undefined;
}

// --- vaultKey ---------------------------------------------------------------
//
// A vault key belongs to one project. `config set vaultKey` saves it in the
// OS credential store under that project, or writes a `${env:NAME}` reference
// into .apivault.json. The key itself never goes into a config file.

/** The project `config ... vaultKey` acts on. It must be set, not defaulted. */
async function vaultKeyProject(projectFlag?: string): Promise<ProjectIdentity> {
  const ref = getActiveProjectId(projectFlag);
  if (!ref) {
    throw new Error(
      "Vault keys are saved per project, and no project is set here. " +
        "Run `apivault projects use <id>` in the project folder, or pass --project <id>.",
    );
  }
  const project = await resolveProject(ref);
  if (!project) throw new Error(`No project "${ref}" found on your account.`);
  return project;
}

/** Drop a plain-text vault key that CLI 1.7 and earlier wrote into .apivault.json. */
function removeLocalPlainVaultKey(): string | null {
  const { config, filePath } = readLocalConfig();
  if (!filePath || typeof config.vaultKey !== "string" || parseEnvReference(config.vaultKey)) {
    return null;
  }
  const updated = { ...config };
  delete updated.vaultKey;
  writeLocalConfig(updated);
  return filePath;
}

async function setVaultKey(
  value: string | undefined,
  opts: ConfigScopeOptions,
  projectFlag: string | undefined,
  json: boolean,
): Promise<void> {
  const scope = resolveScopeOption(opts);
  if (scope === "global") {
    throw new Error(
      "Vault keys belong to a project, so there is no global one. " +
        "Run `apivault config set vaultKey` in the project folder, or pass --project <id>.",
    );
  }

  // A reference to an environment variable goes into .apivault.json as written.
  const variable = value ? parseEnvReference(value) : null;
  if (variable) {
    const reference = value!.trim();
    const result = setConfigValue("vaultKey", reference, { scope: "local" });
    if (json) {
      printJson({ key: "vaultKey", set: true, scope: "local", file: result.targetPath, variable });
      return;
    }
    printSuccess(
      `This project now reads its vault key from ${green(variable)} ${cyan(`[local: ${result.targetPath}]`)}.`,
    );
    if (!process.env[variable]?.trim()) {
      process.stdout.write(yellow("⚠ ") + dim(`${variable} isn't set in this shell yet.\n`));
    }
    return;
  }

  if (scope === "local") {
    throw new Error(
      "A vault key can't be saved in .apivault.json. Point it at an environment variable instead, " +
        "for example `apivault config set vaultKey '${env:APIVAULT_KEY_MY_APP}'`, " +
        `or leave out --local to save the key in ${secretStoreName()}.`,
    );
  }

  const project = await vaultKeyProject(projectFlag);
  // Prompt rather than take the key as an argument, so it stays out of
  // shell history.
  const key = (
    value ?? (await password({ message: `Vault key for ${project.slug}:`, mask: "*" }))
  ).trim();
  if (!key) throw new Error("A vault key is required.");

  setSecret(vaultKeySecretName(project.id), key);
  const cleaned = removeLocalPlainVaultKey();

  if (json) {
    printJson({
      key: "vaultKey",
      set: true,
      project: project.id,
      store: secretStoreName(),
      removedFrom: cleaned,
    });
    return;
  }
  printSuccess(`Saved the vault key for ${green(project.slug)} in ${secretStoreName()}.`);
  if (cleaned) {
    process.stdout.write(
      dim(
        `  Removed the plain-text copy from ${cleaned}. If that file was ever committed, change the vault key.\n`,
      ),
    );
  }
}

async function getVaultKey(
  opts: ConfigScopeOptions,
  projectFlag: string | undefined,
  json: boolean,
): Promise<void> {
  const scope = resolveScopeOption(opts);

  if (scope === "global") {
    const legacy = hasLegacyVaultKey();
    if (json) {
      printJson({ key: "vaultKey", scope: "global", legacySaved: legacy });
      return;
    }
    if (legacy) {
      process.stdout.write(
        `A vault key saved by an older CLI version is in ${secretStoreName()}. ` +
          "Each project it works for gets its own copy. " +
          "Remove it with `apivault config delete vaultKey --global`.\n",
      );
    } else {
      process.stdout.write(dim("There is no global vault key. Vault keys are saved per project.\n"));
      process.exitCode = 1;
    }
    return;
  }

  const { config: localConfig, filePath } = readLocalConfig();
  const local = typeof localConfig.vaultKey === "string" ? localConfig.vaultKey.trim() : "";
  const variable = local ? parseEnvReference(local) : null;

  if (local || scope === "local") {
    const variableSet = variable ? Boolean(process.env[variable]?.trim()) : false;
    if (json) {
      printJson({
        key: "vaultKey",
        scope: "local",
        file: filePath,
        reference: variable ? local : null,
        plainText: Boolean(local && !variable),
        variable,
        variableSet,
      });
      return;
    }
    if (variable) {
      const status = variableSet
        ? green("(set in this shell)")
        : yellow(`(${variable} isn't set in this shell)`);
      process.stdout.write(`${local}  ${status}\n`);
    } else if (local) {
      process.stdout.write(
        yellow(`${filePath} holds a plain-text vault key. Run \`apivault config set vaultKey\` to move it.\n`),
      );
    } else {
      process.stdout.write(dim("No vault key reference in local config.\n"));
      process.exitCode = 1;
    }
    return;
  }

  // A saved key is never printed, so an agent running this command can't
  // read it into its context.
  const project = await vaultKeyProject(projectFlag);
  const saved = getSecret(vaultKeySecretName(project.id));
  if (json) {
    printJson({ key: "vaultKey", project: project.id, saved: saved !== null, store: secretStoreName() });
    return;
  }
  if (saved !== null) {
    process.stdout.write(
      `${dim(maskValue(saved))}  saved for ${green(project.slug)} in ${secretStoreName()}\n`,
    );
  } else {
    process.stdout.write(dim(`No vault key saved for ${project.slug}.\n`));
    process.exitCode = 1;
  }
}

async function deleteVaultKey(
  opts: ConfigScopeOptions,
  projectFlag: string | undefined,
  json: boolean,
): Promise<void> {
  const scope = resolveScopeOption(opts);

  if (scope === "global") {
    const deleted = deleteLegacyVaultKey();
    if (json) {
      printJson({ key: "vaultKey", scope: "global", deleted });
      return;
    }
    if (deleted) {
      printSuccess("Removed the vault key saved by an older CLI version.");
    } else {
      process.stdout.write(dim("There is no global vault key to remove.\n"));
      process.exitCode = 1;
    }
    return;
  }

  const { deletedLocal } = deleteConfigValue("vaultKey", { scope: "local" });
  let deletedSaved = false;
  let project: ProjectIdentity | null = null;
  if (scope !== "local") {
    project = await vaultKeyProject(projectFlag);
    deletedSaved = deleteSecret(vaultKeySecretName(project.id));
  }

  if (json) {
    printJson({
      key: "vaultKey",
      deleted: deletedLocal || deletedSaved,
      deletedLocal,
      deletedSaved,
      project: project?.id ?? null,
    });
    return;
  }
  if (!deletedLocal && !deletedSaved) {
    process.stdout.write(
      dim(`No vault key was set${project ? ` for ${project.slug}` : " in local config"}.\n`),
    );
    process.exitCode = 1;
    return;
  }
  const parts: string[] = [];
  if (deletedSaved) parts.push(`${secretStoreName()} (${project!.slug})`);
  if (deletedLocal) parts.push("local config");
  printSuccess(`Removed vaultKey from ${parts.join(" and ")}.`);
}

/** apivault config list */
function listConfig(opts: ConfigScopeOptions, json: boolean): void {
  const scope = resolveScopeOption(opts);
  const { config: localConfig, filePath: localPath } = readLocalConfig();
  const globalConfig = readGlobalConfig();

  if (json) {
    if (scope === "local") {
      printJson({ scope: "local", file: localPath, config: localConfig });
    } else if (scope === "global") {
      printJson({ scope: "global", config: globalConfig });
    } else {
      printJson({
        local: { file: localPath, config: localConfig },
        global: { config: globalConfig },
      });
    }
    return;
  }

  if (scope === "local") {
    const entries = flattenConfig(localConfig);
    if (!localPath || entries.length === 0) {
      process.stdout.write(dim("No local config set in this directory. Use `apivault config set --local <key> <value>`.\n"));
      return;
    }
    process.stdout.write(dim(`Local configuration (${localPath}):\n`));
    const width = Math.max(...entries.map((e) => e.key.length));
    for (const { key, value } of entries) {
      process.stdout.write(`  ${green(pad(key, width))}  ${displayValue(key, value)}\n`);
    }
    return;
  }

  if (scope === "global") {
    const entries = flattenConfig(globalConfig);
    if (entries.length === 0) {
      process.stdout.write(dim("No global config set. Use `apivault config set --global <key> <value>`.\n"));
      return;
    }
    process.stdout.write(dim("Global configuration (~/.apivault/config.json):\n"));
    const width = Math.max(...entries.map((e) => e.key.length));
    for (const { key, value } of entries) {
      process.stdout.write(`  ${green(pad(key, width))}  ${displayValue(key, value)}\n`);
    }
    return;
  }

  // Combined hierarchical list:
  const localEntries = flattenConfig(localConfig);
  const globalEntries = flattenConfig(globalConfig);
  const allKeys = Array.from(
    new Set([...localEntries.map((e) => e.key), ...globalEntries.map((e) => e.key)]),
  ).sort();

  if (allKeys.length === 0) {
    process.stdout.write(dim("No config set. Use `apivault config set <key> <value>`.\n"));
    return;
  }

  const width = Math.max(...allKeys.map((k) => k.length));
  process.stdout.write(dim("Active configuration (local overrides global):\n"));
  for (const key of allKeys) {
    const localVal = localEntries.find((e) => e.key === key)?.value;
    const globalVal = globalEntries.find((e) => e.key === key)?.value;
    const isLocal = localVal !== undefined;
    const activeVal = isLocal ? localVal : globalVal!;
    const display = displayValue(key, activeVal);
    const sourceTag = isLocal
      ? cyan(" (local)")
      : dim(" (global)");
    process.stdout.write(`  ${green(pad(key, width))}  ${display}${sourceTag}\n`);
  }
  process.stdout.write(
    dim(`\nSaved vault keys are kept in ${secretStoreName()}. Check this project's with \`apivault config get vaultKey\`.\n`),
  );
}

/** apivault config get <key> */
function getConfig(key: string, opts: ConfigScopeOptions, json: boolean): void {
  const scope = resolveScopeOption(opts);
  const value = getConfigValue(key, { scope });
  if (value === undefined) {
    if (json) {
      printJson({ key, set: false, scope: scope || "all" });
      return;
    }
    process.stdout.write(dim(`"${key}" is not set${scope ? ` in ${scope} config` : ""}.\n`));
    process.exitCode = 1;
    return;
  }
  if (json) {
    printJson({ key, value, scope: scope || "resolved" });
    return;
  }
  // `get` is an explicit retrieval — show the raw value even for secrets.
  process.stdout.write(value + "\n");
}

/** apivault config set <key> [value] */
async function setConfig(
  key: string,
  value: string | undefined,
  opts: ConfigScopeOptions,
  json: boolean,
): Promise<void> {
  assertKnownKey(key);

  const scopeOpt = resolveScopeOption(opts);

  // For secret keys, prompt with hidden input when no value is given inline
  // (avoids leaving the vault key in shell history).
  let resolved = value;
  if (resolved === undefined && SECRET_KEYS.has(key)) {
    resolved = (
      await password({ message: `${key}:`, mask: "*" })
    ).trim();
  }
  if (resolved === undefined || resolved === "") {
    throw new Error(`A value is required. Usage: apivault config set <key> <value>`);
  }

  // Default scope decision:
  // If explicitly requested, use it.
  // Otherwise, if local config file already exists or setting 'project', default to 'local'; else 'global'.
  const { filePath: localPath } = readLocalConfig();
  const effectiveScope: "local" | "global" = scopeOpt ?? (localPath ? "local" : "global");

  const result = setConfigValue(key, resolved, { scope: effectiveScope });
  if (json) {
    printJson({ key, set: true, scope: result.scope, file: result.targetPath });
    return;
  }
  const display = SECRET_KEYS.has(key) ? dim(maskValue(resolved)) : resolved;
  const scopeLabel = result.scope === "local" ? cyan(`[local: ${result.targetPath}]`) : dim("[global]");
  printSuccess(`Saved ${key} = ${display} ${scopeLabel}.`, json);
}

/** apivault config delete <key> */
function deleteConfig(key: string, opts: ConfigScopeOptions, json: boolean): void {
  const scopeOpt = resolveScopeOption(opts);
  const { deletedLocal, deletedGlobal } = deleteConfigValue(key, { scope: scopeOpt });
  const anyDeleted = deletedLocal || deletedGlobal;

  if (json) {
    printJson({ key, deleted: anyDeleted, deletedLocal, deletedGlobal });
    return;
  }
  if (anyDeleted) {
    const parts = [];
    if (deletedLocal) parts.push("local");
    if (deletedGlobal) parts.push("global");
    printSuccess(`Removed ${key} from ${parts.join(" and ")} config.`, json);
  } else {
    process.stdout.write(dim(`"${key}" was not set${scopeOpt ? ` in ${scopeOpt} config` : ""}.\n`));
    process.exitCode = 1;
  }
}

/** Register the `config` command group on the parent program. */
export function registerConfigCommand(program: Command): void {
  const json = () => Boolean(program.opts().json);
  const projectFlag = () => program.opts().project as string | undefined;
  const handle = (err: unknown) => {
    reportError(err, json());
    process.exitCode = 1;
  };

  const config = program
    .command("config")
    .description("Manage local and global CLI defaults (project, run command, environment, vault key)");

  config
    .command("list")
    .description("Show all config values (secrets are masked)")
    .option("-l, --local", "Show only local project config")
    .option("-g, --global", "Show only global user config")
    .action((opts: ConfigScopeOptions) => {
      try {
        listConfig(opts, json());
      } catch (err) {
        handle(err);
      }
    });

  config
    .command("get <key>")
    .description("Print a config value (dot path, e.g. run.command, project)")
    .option("-l, --local", "Get only from local project config")
    .option("-g, --global", "Get only from global user config")
    .action(async (key: string, opts: ConfigScopeOptions) => {
      try {
        if (key === "vaultKey") await getVaultKey(opts, projectFlag(), json());
        else getConfig(key, opts, json());
      } catch (err) {
        handle(err);
      }
    });

  config
    .command("set <key> [value]")
    .description(
      "Set a config value. vaultKey is saved per project in the OS credential store " +
        "(hidden prompt when the value is omitted), or as a ${env:NAME} reference in .apivault.json.",
    )
    .option("-l, --local", "Save in local project config (.apivault.json)")
    .option("-g, --global", "Save in global user config (~/.apivault/config.json)")
    .action(async (key: string, value: string | undefined, opts: ConfigScopeOptions) =>
      (key === "vaultKey"
        ? setVaultKey(value, opts, projectFlag(), json())
        : setConfig(key, value, opts, json())
      ).catch(handle),
    );

  config
    .command("delete <key>")
    .description("Remove a config value")
    .option("-l, --local", "Remove only from local project config")
    .option("-g, --global", "Remove only from global user config")
    .action(async (key: string, opts: ConfigScopeOptions) => {
      try {
        if (key === "vaultKey") await deleteVaultKey(opts, projectFlag(), json());
        else deleteConfig(key, opts, json());
      } catch (err) {
        handle(err);
      }
    });
}

