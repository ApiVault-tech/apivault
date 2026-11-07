import { Command } from "commander";
import { input, password, confirm } from "@inquirer/prompts";
import { ApiError, client } from "../http";
import { type GlobalOptions, getConfigValue, getActiveProjectId } from "../config";
import { getServiceIdentity } from "../service-identity";
import {
  renderKeysTable,
  renderKeyDetail,
  printJson,
  printSuccess,
  dim,
  yellow,
  reportError,
} from "../ui/format";

export interface ApiKeyDTO {
  id: string;
  name: string;
  service?: string;
  environment?: string;
  notes?: string | null;
  masked?: string;
  createdAt?: string;
  updatedAt?: string;
  last_used?: string | null;
}

interface KeyOpts extends GlobalOptions {
  json?: boolean;
  reveal?: boolean;
  force?: boolean;
  /** Custom vault key (for reveal on custom-mode accounts). */
  vaultKey?: string;
}

/** Fields `keys add` accepts as flags (enables non-interactive use). */
interface AddKeyFields {
  name?: string;
  service?: string;
  environment?: string;
  /** Stored API key / secret value. */
  key?: string;
  notes?: string;
  /** Custom vault key (custom-mode accounts only). */
  vaultKey?: string;
}

/** apivault keys list */
async function listKeys(opts: KeyOpts): Promise<void> {
  const c = client;
  const keys = await c.request<ApiKeyDTO[]>("/api/keys", { projectId: getActiveProjectId(opts.project) });
  if (opts.json) {
    printJson(keys);
    return;
  }
  if (!keys || keys.length === 0) {
    process.stdout.write(dim("No API keys yet. Add one with `apivault keys add`.\n"));
    return;
  }
  process.stdout.write(renderKeysTable(keys) + "\n");
}

/** apivault keys get <id> [--reveal] */
async function getKey(id: string, opts: KeyOpts): Promise<void> {
  const c = client;
  const projectId = getActiveProjectId(opts.project);
  const revealed = opts.reveal
    ? await revealKeyDetails(c, id, opts.vaultKey, projectId)
    : undefined;
  const key = revealed ?? await c
    .request<ApiKeyDTO>(`/api/keys/${encodeURIComponent(id)}`, { projectId })
    .catch((err) => {
      if (err instanceof ApiError && err.status === 404) {
        throw new ApiError(`No key with id "${id}".`, 404, undefined);
      }
      throw err;
    });
  const rawKey = revealed?.rawKey;

  if (opts.json) {
    printJson({ ...key, ...(rawKey ? { rawKey } : {}) });
    return;
  }

  process.stdout.write(renderKeyDetail(key, { showRaw: opts.reveal, rawKey }) + "\n");
  if (opts.reveal) {
    process.stdout.write(
      yellow("⚠ ") + "This is a secret. Avoid sharing or pasting it anywhere untrusted.\n",
    );
  }
}

/**
 * Resolve the custom vault key from (in order): an explicit flag,
 * APIVAULT_KEY, or config vaultKey.
 */
export function resolveVaultKey(vaultKeyFlag?: string): string | undefined {
  return (vaultKeyFlag ?? process.env.APIVAULT_KEY ?? getConfigValue("vaultKey"))?.trim() || undefined;
}

async function promptVaultKey(): Promise<string> {
  return (
    await password({
      message: "Vault key (custom encryption):",
      mask: "*",
    })
  ).trim();
}

/**
 * Run a vault-key-protected request. Sends X-Vault-Key when a vault key is
 * available; prompts on VAULT_KEY_REQUIRED if none was provided yet.
 */
async function withVaultKey<T>(
  vaultKeyFlag: string | undefined,
  fn: (headers: Record<string, string>) => Promise<T>,
): Promise<T> {
  const vaultKey = resolveVaultKey(vaultKeyFlag);
  const headersFor = (customVaultKey?: string): Record<string, string> => {
    const h: Record<string, string> = {};
    const value = customVaultKey ?? vaultKey;
    if (value) h["X-Vault-Key"] = value;
    return h;
  };

  try {
    return await fn(headersFor());
  } catch (err) {
    if (err instanceof ApiError && err.code === "VAULT_KEY_REQUIRED") {
      if (vaultKey) throw new ApiError("That vault key is incorrect.", 403, undefined);
      if (!canPrompt()) {
        throw new ApiError(
          "This project uses a custom vault key, and there is no terminal to ask for it. " +
            "Pass --vault-key or set APIVAULT_KEY.",
          400,
          undefined,
        );
      }
      const customVaultKey = await promptVaultKey();
      return fn(headersFor(customVaultKey));
    }
    throw err;
  }
}

/**
 * Decrypt a key. Default-mode accounts work with just the Bearer token.
 * Custom-mode accounts need the vault key via resolveVaultKey or prompt.
 */
export async function revealKey(
  c: typeof client,
  id: string,
  keyFlag?: string,
  projectId?: string,
): Promise<string> {
  return (await revealKeyDetails(c, id, keyFlag, projectId)).rawKey;
}

async function revealKeyDetails(
  c: typeof client,
  id: string,
  keyFlag?: string,
  projectId?: string,
): Promise<ApiKeyDTO & { rawKey: string }> {
  const decrypted = await withVaultKey(keyFlag, (headers) => {
    const url = projectId
      ? `/api/keys/${encodeURIComponent(id)}/decrypt?projectId=${projectId}`
      : `/api/keys/${encodeURIComponent(id)}/decrypt`;
    return c.request<ApiKeyDTO & { rawKey?: string; error?: string }>(
      url,
      { method: "POST", headers, projectId },
    );
  });
  if (!decrypted?.rawKey) throw new ApiError("Could not decrypt that key.", 500, decrypted);
  return decrypted as ApiKeyDTO & { rawKey: string };
}

/** True when a person is actually there to answer a prompt. */
function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * A value that must come from a flag when nobody can answer a prompt.
 *
 * A build runner has no terminal, so asking would hang until the step is
 * killed. Naming the missing flag turns that into an error the log explains.
 */
async function flagOrPrompt(
  value: string | undefined,
  flag: string,
  ask: () => Promise<string>,
): Promise<string> {
  const given = value?.trim();
  if (given) return given;
  if (!canPrompt()) {
    throw new ApiError(
      `${flag} is required when running without a terminal (no TTY to prompt on).`,
      400,
      undefined,
    );
  }
  return (await ask()).trim();
}

/** apivault keys add — interactive, or fully via flags for scripting. */
async function addKey(opts: KeyOpts & AddKeyFields): Promise<void> {
  const c = client;
  const projectId = getActiveProjectId(opts.project);

  const name = await flagOrPrompt(opts.name, "--name", () =>
    input({
      message: "Key name:",
      validate: (v) => (v.trim() ? true : "Name is required."),
    }),
  );
  const service = (
    opts.service?.trim() ||
    (canPrompt() ? await input({ message: "Service:", default: "Custom" }) : "Custom")
  ).trim();

  // A pinned service token can only write into its own environment, so use it
  // rather than making every pipeline repeat --environment. Without a pin and
  // without a terminal there is no safe default: guessing "Production" here
  // could put a secret in the wrong environment, so require the flag instead.
  const pinnedEnvironment = (await getServiceIdentity())?.environment ?? undefined;
  const environment = (
    opts.environment?.trim() ||
    pinnedEnvironment ||
    (await flagOrPrompt(undefined, "--environment", () =>
      input({ message: "Environment:", default: "Production" }),
    ))
  ).trim();

  const keyValue = await flagOrPrompt(opts.key, "--key", () =>
    password({
      message: "API key value:",
      mask: "*",
      validate: (v) => (v.trim() ? true : "Key value is required."),
    }),
  );
  const notes =
    opts.notes !== undefined
      ? opts.notes.trim()
      : canPrompt()
        ? (await input({ message: "Notes (optional):", default: "" })).trim()
        : "";

  const created = await withVaultKey(opts.vaultKey, (headers) =>
    c.request<ApiKeyDTO>("/api/keys", {
      method: "POST",
      headers,
      projectId,
      json: {
        name,
        service,
        environment,
        notes: notes || undefined,
        key: keyValue,
      },
    }),
  );

  if (opts.json) {
    printJson(created);
    return;
  }
  printSuccess(`Saved "${created.name}" (id ${dim(created.id)}).`);
}

/** apivault keys update <id> (interactive) */
async function updateKey(id: string, opts: KeyOpts): Promise<void> {
  // Every field is prompted, so there is nothing to fall back to without a
  // terminal. Say so rather than letting the prompt library abort on a closed
  // stdin, which reports as "User force closed the prompt".
  if (!canPrompt()) {
    throw new ApiError(
      "`keys update` is interactive and needs a terminal. In a pipeline, replace the value with " +
        "`keys delete` followed by `keys add --name ... --key ...`.",
      400,
      undefined,
    );
  }

  const c = client;
  const projectId = getActiveProjectId(opts.project);

  const existing = await c
    .request<ApiKeyDTO>(`/api/keys/${encodeURIComponent(id)}`, { projectId })
    .catch((err) => {
      if (err instanceof ApiError && err.status === 404) {
        throw new ApiError(`No key with id "${id}".`, 404, undefined);
      }
      throw err;
    });

  const name = await input({
    message: "Key name:",
    default: existing.name,
    validate: (v) => (v.trim() ? true : "Name is required."),
  });
  const service = await input({
    message: "Service:",
    default: existing.service ?? "Custom",
  });
  const environment = await input({
    message: "Environment:",
    default: existing.environment ?? "Production",
  });
  const changeKey = await confirm({
    message: "Change the API key value?",
    default: false,
  });
  let keyValue: string | undefined;
  if (changeKey) {
    keyValue = await password({
      message: "New API key value:",
      mask: "*",
      validate: (v) => (v.trim() ? true : "Key value is required."),
    });
  }
  const notes = await input({
    message: "Notes:",
    default: existing.notes ?? "",
  });

  const updated = await withVaultKey(undefined, (headers) =>
    c.request<ApiKeyDTO>(`/api/keys/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers,
      projectId,
      json: {
        name: name.trim(),
        service: service.trim(),
        environment: environment.trim(),
        notes: notes.trim(),
        ...(keyValue ? { key: keyValue.trim() } : {}),
      },
    }),
  );

  if (opts.json) {
    printJson(updated);
    return;
  }
  printSuccess(`Updated "${name.trim()}" (id ${dim(id)}).`);
}

/** apivault keys delete <id> */
async function deleteKey(id: string, opts: KeyOpts): Promise<void> {
  const c = client;
  const projectId = getActiveProjectId(opts.project);

  const existing = await c
    .request<ApiKeyDTO>(`/api/keys/${encodeURIComponent(id)}`, { projectId })
    .catch((err) => {
      if (err instanceof ApiError && err.status === 404) {
        throw new ApiError(`No key with id "${id}".`, 404, undefined);
      }
      throw err;
    });

  if (!opts.force && !opts.json) {
    // Deleting is irreversible, so an unattended shell must say so explicitly.
    // Treating "nobody is here to confirm" as a yes would be the wrong default
    // for the one command that cannot be undone.
    if (!canPrompt()) {
      throw new ApiError(
        `Refusing to delete "${existing.name}" without confirmation. ` +
          "There is no terminal to confirm on — pass -f to delete unattended.",
        400,
        undefined,
      );
    }
    const ok = await confirm({
      message: `Delete "${existing.name}" (${dim(id)})? This cannot be undone.`,
      default: false,
    });
    if (!ok) {
      process.stdout.write(dim("Cancelled.\n"));
      return;
    }
  }

  await c.request<{ success?: boolean }>(`/api/keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
    projectId,
  });

  if (opts.json) {
    printJson({ deleted: true, id });
    return;
  }
  printSuccess(`Deleted "${existing.name}" (${dim(id)}).`);
}

/** Register the `keys` command group on the parent program. */
export function registerKeysCommand(program: Command): void {
  // Global opts (url/json) live on the root program; read them per action.
  const globals = () => program.opts() as KeyOpts;
  const json = () => Boolean(program.opts().json);
  const handle = (err: unknown) => {
    reportError(err, json());
    process.exitCode = 1;
  };

  const keys = program
    .command("keys")
    .description("Manage your stored API keys");

  keys
    .command("list")
    .description("List all keys (masked)")
    .action(async () => listKeys(globals()).catch(handle));

  keys
    .command("get <id>")
    .description("Show a key. Use --reveal to decrypt and print the raw value.")
    .option("--reveal", "Decrypt and print the raw key value")
    .option(
      "--vault-key <vaultKey>",
      "Vault key for projects in custom encryption mode (or set APIVAULT_KEY)",
    )
    .action(async (id: string, local: { reveal?: boolean; vaultKey?: string }) =>
      getKey(id, { ...globals(), reveal: local.reveal, vaultKey: local.vaultKey }).catch(handle),
    );

  keys
    .command("add")
    .description("Add a new API key (interactive, or fully via flags)")
    .option("--name <name>", "Key name")
    .option("--service <service>", "Service (default: Custom)")
    .option("--environment <env>", "Environment (default: Production)")
    .option("--key <value>", "API key / secret value to store")
    .option(
      "--vault-key <vaultKey>",
      "Vault key for projects in custom encryption mode (or set APIVAULT_KEY)",
    )
    .option("--notes <notes>", "Notes")
    .action(async (local: AddKeyFields) =>
      addKey({ ...globals(), ...local }).catch(handle),
    );

  keys
    .command("update <id>")
    .description("Edit a key (interactive)")
    .action(async (id: string) =>
      updateKey(id, { ...globals() }).catch(handle),
    );

  keys
    .command("delete <id>")
    .description("Delete a key")
    .option("-f, --force", "Skip the confirmation prompt")
    .action(async (id: string, local: { force?: boolean }) =>
      deleteKey(id, { ...globals(), force: local.force }).catch(handle),
    );
}
