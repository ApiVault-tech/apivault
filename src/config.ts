import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deleteSecret, getSecret, setSecret } from "./secret-store";

/**
 * Base URL of the ApiVault instance the CLI talks to.
 *
 * Hardcoded by design: end users never configure this. For local development it
 * points at the dev server; change this constant when you deploy and rebuild.
 */
export const API_BASE_URL = "https://apivault.tech";

export interface GlobalOptions {
  /** Emit machine-readable JSON instead of formatted tables. */
  json?: boolean;
  /** Maximum seconds to wait for browser approval during login. */
  timeout?: number;
  /** Explicitly override the project context via flag. */
  project?: string;
}

const DATA_DIR = join(homedir(), ".apivault");
const TOKEN_PATH = join(DATA_DIR, "token.json");
const CONFIG_PATH = join(DATA_DIR, "config.json");

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

/** Stored token payload. */
export interface StoredToken {
  apiToken: string;
  email?: string | null;
  name?: string | null;
  createdAt?: string;
  /**
   * When the server will stop accepting this token (ISO 8601). Absent for
   * tokens saved by CLI versions predating server-side expiry, and for
   * tokens the server itself minted without one.
   */
  expiresAt?: string | null;
}

/** Name of the login token's entry in the secret store. */
const TOKEN_SECRET = "login-token";

function parseStoredToken(raw: string): StoredToken | null {
  try {
    const parsed = JSON.parse(raw) as StoredToken;
    return typeof parsed.apiToken === "string" && parsed.apiToken ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Move a token saved by CLI 1.7 and earlier, in plain text at
 * ~/.apivault/token.json, into the secret store, then delete the file.
 */
function migrateTokenFile(): void {
  if (!existsSync(TOKEN_PATH)) return;
  try {
    const legacy = parseStoredToken(readFileSync(TOKEN_PATH, "utf8"));
    if (legacy && !getSecret(TOKEN_SECRET)) setSecret(TOKEN_SECRET, JSON.stringify(legacy));
    unlinkSync(TOKEN_PATH);
  } catch {
    // Leave the file in place; it is read again next time.
  }
}

/** Read the full persisted token record, or null if signed out. */
export function readStoredToken(): StoredToken | null {
  migrateTokenFile();
  const raw = getSecret(TOKEN_SECRET);
  if (raw) return parseStoredToken(raw);
  // The store couldn't take the migrated token: keep using the old file.
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    return parseStoredToken(readFileSync(TOKEN_PATH, "utf8"));
  } catch {
    return null;
  }
}

/**
 * True when this process is authenticating as a machine rather than a person.
 *
 * `APIVAULT_TOKEN` is how a service token reaches the CLI in CI, where there is
 * no browser to approve a login and no saved login token to read.
 */
export function isServiceTokenMode(): boolean {
  return Boolean(process.env.APIVAULT_TOKEN?.trim());
}

/**
 * The API token this process should use.
 *
 * `APIVAULT_TOKEN` wins over the stored device token: in CI there is nothing
 * stored, and on a developer's machine where both exist the environment
 * variable is the deliberate, explicit choice.
 */
export function readToken(): string | null {
  const fromEnv = process.env.APIVAULT_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return readStoredToken()?.apiToken ?? null;
}

/**
 * Parsed expiry of the stored token, or null when it has none (or is
 * unparseable — treated as "no expiry" rather than as already expired, so a
 * corrupt field never locks a working token out).
 */
export function getTokenExpiry(): Date | null {
  // A service token's expiry lives on the server, not in a local file. Reading
  // the saved login token here would report some other credential's
  // expiry — or none — for the token actually in use.
  if (isServiceTokenMode()) return null;
  const stored = readStoredToken();
  if (!stored?.expiresAt) return null;
  const parsed = new Date(stored.expiresAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** True when the stored token carries an expiry that has already passed. */
export function isTokenExpired(): boolean {
  const expiry = getTokenExpiry();
  return expiry !== null && expiry.getTime() <= Date.now();
}

/** Persist the API token (with optional user identity) after a successful login. */
export function writeToken(token: {
  apiToken: string;
  email?: string | null;
  name?: string | null;
  expiresAt?: string | null;
}): void {
  const payload: StoredToken = { ...token, createdAt: new Date().toISOString() };
  setSecret(TOKEN_SECRET, JSON.stringify(payload));
  try {
    if (existsSync(TOKEN_PATH)) unlinkSync(TOKEN_PATH);
  } catch {
    // best-effort
  }
}

/** Remove the persisted token (logout). */
export function clearToken(): void {
  deleteSecret(TOKEN_SECRET);
  try {
    if (existsSync(TOKEN_PATH)) unlinkSync(TOKEN_PATH);
  } catch {
    // best-effort
  }
}

// --- Local and Global config (defaults for `run`, stored vault key, etc.) ---

/** Shape of config JSON. Unknown keys are preserved as-is. */
export interface StoredConfig {
  run?: {
    command?: string;
    env?: string;
  };
  vaultKey?: string;
  project?: string;
  projectId?: string;
  [key: string]: unknown;
}

export type ConfigScope = "all" | "local" | "global";

/** Read the persisted global config (~/.apivault/config.json). */
export function readGlobalConfig(): StoredConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as StoredConfig) : {};
  } catch {
    return {};
  }
}

/** Alias for backwards compatibility. */
export const readConfig = readGlobalConfig;

/** Persist global config to ~/.apivault/config.json. */
export function writeGlobalConfig(config: StoredConfig): void {
  ensureDataDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  if (process.platform !== "win32") {
    try {
      chmodSync(CONFIG_PATH, 0o600);
    } catch {
      // best-effort
    }
  }
}

/** Alias for backwards compatibility. */
export const writeConfig = writeGlobalConfig;

const LOCAL_CONFIG_CANDIDATES = [
  ".apivault.json",
  ".apivaultrc",
  "apivault.json",
  ".apivault",
];

/** Locate any existing local project config file in the given (or current) directory. */
export function findLocalConfigFile(cwd: string = process.cwd()): string | null {
  for (const name of LOCAL_CONFIG_CANDIDATES) {
    const fullPath = join(cwd, name);
    if (existsSync(fullPath)) return fullPath;
  }
  return null;
}

/** Read local project config from current directory, if present. */
export function readLocalConfig(cwd: string = process.cwd()): { config: StoredConfig; filePath: string | null } {
  const filePath = findLocalConfigFile(cwd);
  if (!filePath) return { config: {}, filePath: null };

  try {
    const raw = readFileSync(filePath, "utf8");
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return { config: parsed as StoredConfig, filePath };
      }
    } catch {
      // If raw file content is just a plain project ID string (like .apivault)
      const trimmed = raw.trim();
      if (trimmed.length > 0) {
        return { config: { project: trimmed }, filePath };
      }
    }
  } catch {
    // Ignore read errors
  }
  return { config: {}, filePath: null };
}

/**
 * Write to local project config in the given (or current) directory.
 * Writes to existing local config file if one exists, otherwise creates `.apivault.json`.
 */
export function writeLocalConfig(config: StoredConfig, cwd: string = process.cwd()): string {
  const targetPath = findLocalConfigFile(cwd) || join(cwd, ".apivault.json");
  writeFileSync(targetPath, JSON.stringify(config, null, 2), "utf8");
  return targetPath;
}

/** Remove the local project configuration file in the current directory. */
export function unlinkLocalProject(cwd: string = process.cwd()): boolean {
  const targetPath = findLocalConfigFile(cwd);
  if (targetPath && existsSync(targetPath)) {
    try {
      unlinkSync(targetPath);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Check for a local project binding in the current directory. */
export function getLocalProject(): string | undefined {
  const { config } = readLocalConfig();
  if (typeof config.project === "string" && config.project.trim()) {
    return config.project.trim();
  }
  if (typeof config.projectId === "string" && config.projectId.trim()) {
    return config.projectId.trim();
  }
  return undefined;
}

/** 
 * Resolve the active project ID.
 * Priority: 1. CLI flag (-p) 2. Environment variable (APIVAULT_PROJECT) 3. Local directory config 4. Global config
 */
export function getActiveProjectId(cliFlag?: string): string | undefined {
  if (cliFlag?.trim()) return cliFlag.trim();
  if (process.env.APIVAULT_PROJECT?.trim()) return process.env.APIVAULT_PROJECT.trim();
  const local = getLocalProject();
  if (local) return local;
  return getConfigValue("project", { scope: "global" });
}

function extractNestedValue(config: StoredConfig, path: string): string | undefined {
  const segments = path.split(".");
  let node: unknown = config;
  for (const seg of segments) {
    if (node && typeof node === "object" && seg in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return typeof node === "string" ? node : undefined;
}

function setNestedValue(config: StoredConfig, path: string, value: string): StoredConfig {
  const updated = { ...config };
  const segments = path.split(".");
  let node: Record<string, unknown> = updated;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (typeof node[seg] !== "object" || node[seg] === null) {
      node[seg] = {};
    }
    node = node[seg] as Record<string, unknown>;
  }
  node[segments[segments.length - 1]] = value;
  return updated;
}

function deleteNestedValue(config: StoredConfig, path: string): { updated: StoredConfig; deleted: boolean } {
  const updated = { ...config };
  const segments = path.split(".");
  let node: unknown = updated;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (node && typeof node === "object" && seg in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[seg];
    } else {
      return { updated, deleted: false };
    }
  }
  const last = segments[segments.length - 1];
  const leaf = node as Record<string, unknown>;
  if (node && typeof node === "object" && last in leaf) {
    delete leaf[last];
    return { updated, deleted: true };
  }
  return { updated, deleted: false };
}

/**
 * Get a nested config value by dot path (e.g. "run.command", "vaultKey", "project").
 * Checks local config first (unless scope is 'global'), then global config (unless scope is 'local').
 */
export function getConfigValue(
  path: string,
  options?: { scope?: ConfigScope },
): string | undefined {
  const scope = options?.scope ?? "all";

  if (scope === "local" || scope === "all") {
    const { config: localConfig } = readLocalConfig();
    const localVal = extractNestedValue(localConfig, path);
    if (localVal !== undefined) return localVal;
  }

  if (scope === "global" || scope === "all") {
    const globalConfig = readGlobalConfig();
    const globalVal = extractNestedValue(globalConfig, path);
    if (globalVal !== undefined) return globalVal;
  }

  return undefined;
}

/**
 * Set a nested config value by dot path.
 * Scope determines whether it is written to local directory config (`.apivault.json`) or global config.
 */
export function setConfigValue(
  path: string,
  value: string,
  options?: { scope?: "local" | "global" },
): { scope: "local" | "global"; targetPath: string } {
  const scope = options?.scope ?? "global";
  if (scope === "local") {
    const { config: localConfig } = readLocalConfig();
    const updated = setNestedValue(localConfig, path, value);
    const targetPath = writeLocalConfig(updated);
    return { scope: "local", targetPath };
  } else {
    const globalConfig = readGlobalConfig();
    const updated = setNestedValue(globalConfig, path, value);
    writeGlobalConfig(updated);
    return { scope: "global", targetPath: CONFIG_PATH };
  }
}

/**
 * Delete a nested config value by dot path.
 */
export function deleteConfigValue(
  path: string,
  options?: { scope?: "local" | "global" | "all" },
): { deletedLocal: boolean; deletedGlobal: boolean } {
  const scope = options?.scope ?? "all";
  let deletedLocal = false;
  let deletedGlobal = false;

  if (scope === "local" || scope === "all") {
    const { config: localConfig, filePath } = readLocalConfig();
    if (filePath) {
      const { updated, deleted } = deleteNestedValue(localConfig, path);
      if (deleted) {
        writeLocalConfig(updated);
        deletedLocal = true;
      }
    }
  }

  if (scope === "global" || scope === "all") {
    const globalConfig = readGlobalConfig();
    const { updated, deleted } = deleteNestedValue(globalConfig, path);
    if (deleted) {
      writeGlobalConfig(updated);
      deletedGlobal = true;
    }
  }

  return { deletedLocal, deletedGlobal };
}
