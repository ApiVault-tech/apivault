import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the CLI keeps secrets on this machine: the login token and saved
 * vault keys.
 *
 * The OS credential store is the default: Keychain on macOS, Credential
 * Manager on Windows, the Secret Service (libsecret) on Linux. It encrypts
 * the values and keeps them out of any file that backups, sync tools or
 * `git add` would pick up.
 *
 * Machines without one (a headless Linux box, some containers) fall back to
 * `~/.apivault/secrets.json`, readable only by the owner on macOS and Linux.
 * Pipelines should not rely on either: they pass `APIVAULT_TOKEN` and
 * `APIVAULT_KEY` in the environment.
 */

const SERVICE = "apivault";
const DATA_DIR = join(homedir(), ".apivault");
const FALLBACK_PATH = join(DATA_DIR, "secrets.json");

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

type EntryConstructor = new (service: string, account: string) => KeyringEntry;

let entryClass: EntryConstructor | null | undefined;

/**
 * The keyring binding, or null when this platform has none or its store
 * can't be reached. Probed once per process: a store that is missing stays
 * missing for the few hundred milliseconds a command runs.
 */
function keyring(): EntryConstructor | null {
  if (entryClass !== undefined) return entryClass;
  if (process.env.APIVAULT_NO_KEYCHAIN?.trim()) return (entryClass = null);
  try {
    // Loaded lazily so an unsupported platform (no prebuilt binary) falls
    // back to the file instead of crashing every command at startup.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Entry } = require("@napi-rs/keyring") as { Entry: EntryConstructor };
    // Reading an entry that doesn't exist returns null; a store that isn't
    // running (no D-Bus session on Linux, for example) throws here.
    new Entry(SERVICE, "probe").getPassword();
    entryClass = Entry;
  } catch {
    entryClass = null;
  }
  return entryClass;
}

/** True when secrets go to the OS credential store rather than a file. */
export function usesKeychain(): boolean {
  return keyring() !== null;
}

/** Human name of where secrets are stored, for messages. */
export function secretStoreName(): string {
  if (!usesKeychain()) return "~/.apivault/secrets.json";
  if (process.platform === "darwin") return "the macOS Keychain";
  if (process.platform === "win32") return "Windows Credential Manager";
  return "the system keyring";
}

function readFallback(): Record<string, string> {
  try {
    if (!existsSync(FALLBACK_PATH)) return {};
    const parsed = JSON.parse(readFileSync(FALLBACK_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeFallback(values: Record<string, string>): void {
  if (Object.keys(values).length === 0) {
    try {
      if (existsSync(FALLBACK_PATH)) unlinkSync(FALLBACK_PATH);
    } catch {
      // best-effort
    }
    return;
  }
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FALLBACK_PATH, JSON.stringify(values, null, 2), { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    try {
      chmodSync(FALLBACK_PATH, 0o600);
    } catch {
      // best-effort
    }
  }
}

/** Read a secret, or null when none is saved under that name. */
export function getSecret(account: string): string | null {
  const Entry = keyring();
  if (Entry) {
    try {
      const value = new Entry(SERVICE, account).getPassword();
      if (value !== null) return value;
    } catch {
      // A locked or unreadable store: fall through to the file.
    }
  }
  return readFallback()[account] ?? null;
}

/** Save a secret, replacing any earlier value under that name. */
export function setSecret(account: string, value: string): void {
  const Entry = keyring();
  if (Entry) {
    new Entry(SERVICE, account).setPassword(value);
    // Drop a copy an earlier run left in the fallback file, so the file never
    // holds a stale value that would win if the store became unreachable.
    const fallback = readFallback();
    if (account in fallback) {
      delete fallback[account];
      writeFallback(fallback);
    }
    return;
  }
  writeFallback({ ...readFallback(), [account]: value });
}

/** Delete a secret from both places. Returns true when one existed. */
export function deleteSecret(account: string): boolean {
  let deleted = false;
  const Entry = keyring();
  if (Entry) {
    try {
      deleted = new Entry(SERVICE, account).deletePassword();
    } catch {
      // best-effort
    }
  }
  const fallback = readFallback();
  if (account in fallback) {
    delete fallback[account];
    writeFallback(fallback);
    deleted = true;
  }
  return deleted;
}
