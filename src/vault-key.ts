import { confirm, password } from "@inquirer/prompts";
import { ApiError, client } from "./http";
import { isServiceTokenMode, readGlobalConfig, readLocalConfig, writeGlobalConfig } from "./config";
import { deleteSecret, getSecret, secretStoreName, setSecret } from "./secret-store";
import { dim, yellow } from "./ui/format";

/**
 * Custom vault keys belong to a project, so the CLI looks one up in this order:
 *
 * 1. `--vault-key`
 * 2. `APIVAULT_KEY` (a pipeline or a one-off command)
 * 3. `vaultKey` in `.apivault.json`, written as `${env:NAME}` so the file
 *    names a variable and never holds the key itself
 * 4. The key saved for this project in the OS credential store
 *    (`apivault config set vaultKey`)
 * 5. A key saved by CLI 1.7 or earlier, when it was one key for the account.
 *    The first project it works for gets its own copy.
 * 6. A prompt, when someone is at the terminal
 */

/** Secret-store entry for the key saved by CLI 1.7 and earlier. */
const LEGACY_SECRET = "vault-key:legacy";

/** Global-config list of projects the legacy key has already failed for. */
const LEGACY_SKIP_KEY = "vaultKeyLegacySkip";

const ENV_REFERENCE = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

export interface ProjectIdentity {
  id: string;
  slug: string;
  name: string;
}

/** Secret-store entry name for a project's vault key. */
export function vaultKeySecretName(projectId: string): string {
  return `vault-key:${projectId}`;
}

/** The variable name in a `${env:NAME}` reference, or null for anything else. */
export function parseEnvReference(value: string): string | null {
  return ENV_REFERENCE.exec(value.trim())?.[1] ?? null;
}

const warned = new Set<string>();

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  process.stderr.write(yellow("⚠ ") + dim(message) + "\n");
}

/** The vault key `.apivault.json` points at, if it sets one. */
function localConfigVaultKey(): string | undefined {
  const { config, filePath } = readLocalConfig();
  const raw = typeof config.vaultKey === "string" ? config.vaultKey.trim() : "";
  if (!raw || !filePath) return undefined;

  const name = parseEnvReference(raw);
  if (name) {
    const value = process.env[name]?.trim();
    if (!value) {
      throw new ApiError(
        `${filePath} reads the vault key from ${name}, but ${name} isn't set in this shell.`,
        400,
        undefined,
      );
    }
    return value;
  }

  // Written by CLI 1.7 and earlier, which saved the key itself here.
  warnOnce(
    `${filePath} holds your vault key in plain text. Run \`apivault config set vaultKey\` ` +
      `to move it to ${secretStoreName()}.`,
  );
  return raw;
}

/** The variable `.apivault.json` reads the vault key from, as a list. */
export function vaultKeyVariables(): string[] {
  const { config } = readLocalConfig();
  const name = typeof config.vaultKey === "string" ? parseEnvReference(config.vaultKey) : null;
  return name ? [name] : [];
}

/** A vault key given for this run: flag, environment, or `.apivault.json`. */
export function explicitVaultKey(flag?: string): string | undefined {
  return flag?.trim() || process.env.APIVAULT_KEY?.trim() || localConfigVaultKey();
}

/**
 * Move a vault key that CLI 1.7 and earlier saved in plain text in
 * ~/.apivault/config.json into the secret store. Runs at startup so the
 * plain-text copy is gone as soon as the new version runs.
 */
export function migrateGlobalVaultKey(): void {
  const config = readGlobalConfig();
  const legacy = typeof config.vaultKey === "string" ? config.vaultKey.trim() : "";
  if (!("vaultKey" in config)) return;
  try {
    if (legacy && !getSecret(LEGACY_SECRET)) setSecret(LEGACY_SECRET, legacy);
  } catch {
    return; // Keep the file copy rather than lose the key.
  }
  delete config.vaultKey;
  writeGlobalConfig(config);
  if (legacy) {
    warnOnce(
      `Moved your saved vault key from ~/.apivault/config.json to ${secretStoreName()}. ` +
        "Vault keys are now saved per project; each project that uses this key gets its own copy.",
    );
  }
}

function legacySkipList(): string[] {
  const list = readGlobalConfig()[LEGACY_SKIP_KEY];
  return Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [];
}

function skipLegacyFor(projectId: string): void {
  const config = readGlobalConfig();
  config[LEGACY_SKIP_KEY] = [...new Set([...legacySkipList(), projectId])];
  writeGlobalConfig(config);
}

/** True when a key saved by CLI 1.7 or earlier is still waiting to be adopted. */
export function hasLegacyVaultKey(): boolean {
  return getSecret(LEGACY_SECRET) !== null;
}

/** Remove the key saved by CLI 1.7 or earlier. */
export function deleteLegacyVaultKey(): boolean {
  const config = readGlobalConfig();
  if (LEGACY_SKIP_KEY in config) {
    delete config[LEGACY_SKIP_KEY];
    writeGlobalConfig(config);
  }
  return deleteSecret(LEGACY_SECRET);
}

const projectCache = new Map<string, ProjectIdentity | null>();

/**
 * The project a request goes to, matched the way the server matches it: by
 * id, then by slug, then the first project the user joined when none is set.
 * Service tokens can't list projects and use `APIVAULT_KEY` instead.
 */
export async function resolveProject(projectRef?: string): Promise<ProjectIdentity | null> {
  if (isServiceTokenMode()) return null;
  const cacheKey = projectRef ?? "";
  if (projectCache.has(cacheKey)) return projectCache.get(cacheKey)!;
  const projects = await client.request<ProjectIdentity[]>("/api/projects");
  const match = !projectRef
    ? projects[0]
    : (projects.find((p) => p.id === projectRef) ?? projects.find((p) => p.slug === projectRef));
  projectCache.set(cacheKey, match ?? null);
  return match ?? null;
}

function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function errorCode(err: unknown): string | undefined {
  return err instanceof ApiError ? err.code : undefined;
}

/** Keys that worked in this process, so `run` asks once rather than per secret. */
const workingKeys = new Map<string, string>();

/**
 * Run a request that may need the project's vault key. Sends X-Vault-Key when
 * a key is known, and works through the saved keys and a prompt when the
 * server answers VAULT_KEY_REQUIRED.
 */
export async function withVaultKey<T>(
  flag: string | undefined,
  projectRef: string | undefined,
  fn: (headers: Record<string, string>) => Promise<T>,
): Promise<T> {
  const headersFor = (key?: string): Record<string, string> => (key ? { "X-Vault-Key": key } : {});
  const cacheKey = projectRef ?? "";
  const known = explicitVaultKey(flag) ?? workingKeys.get(cacheKey);

  try {
    return await fn(headersFor(known));
  } catch (err) {
    if (errorCode(err) !== "VAULT_KEY_REQUIRED") throw err;
    if (known) throw new ApiError("That vault key is incorrect.", 403, undefined);
  }

  const remember = (key: string, result: T): T => {
    workingKeys.set(cacheKey, key);
    return result;
  };

  // The project needs a key and none was given for this run.
  const project = await resolveProject(projectRef).catch(() => null);
  if (project) {
    const saved = getSecret(vaultKeySecretName(project.id));
    if (saved) {
      try {
        return remember(saved, await fn(headersFor(saved)));
      } catch (err) {
        if (errorCode(err) !== "INVALID_VAULT_KEY") throw err;
        throw new ApiError(
          `The vault key saved for ${project.slug} is incorrect. ` +
            "Run `apivault config set vaultKey` in the project folder to replace it.",
          403,
          undefined,
        );
      }
    }

    const legacy = getSecret(LEGACY_SECRET);
    if (legacy && !legacySkipList().includes(project.id)) {
      try {
        const result = await fn(headersFor(legacy));
        setSecret(vaultKeySecretName(project.id), legacy);
        return remember(legacy, result);
      } catch (err) {
        if (errorCode(err) !== "INVALID_VAULT_KEY") throw err;
        // Not this project's key. Don't try it here again: every wrong
        // attempt shows up in the project's logs.
        skipLegacyFor(project.id);
      }
    }
  }

  if (!canPrompt()) {
    throw new ApiError(
      "This project uses a custom vault key, and there is no terminal to ask for it. " +
        "Pass --vault-key, set APIVAULT_KEY, or run `apivault config set vaultKey` in the project folder.",
      400,
      undefined,
    );
  }
  const typed = (await password({ message: "Vault key (custom encryption):", mask: "*" })).trim();
  const result = remember(typed, await fn(headersFor(typed)));

  if (project) {
    const save = await confirm({
      message: `Save this vault key for ${project.slug} in ${secretStoreName()}?`,
      default: true,
    });
    if (save) setSecret(vaultKeySecretName(project.id), typed);
  }
  return result;
}
