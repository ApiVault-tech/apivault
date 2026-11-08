<p align="center">
  <a href="https://apivault.tech">
    <img src="https://apivault.tech/apivault-cli.png" width="360" alt="ApiVault Logo" style="max-width: 100%;">
  </a>
</p>

<p align="center">
  The official command-line interface for <strong><a href="https://apivault.tech">ApiVault</a></strong> — manage encrypted API keys, inject secrets into local processes, and sync environment variables from your terminal.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/apivault"><img src="https://img.shields.io/npm/v/apivault.svg?style=flat-square&color=6366f1" alt="npm version"></a>
  <a href="https://github.com/ApiVault-tech/apivault/blob/main/LICENSE"><img src="https://img.shields.io/github/license/ApiVault-tech/apivault.svg?style=flat-square&color=10b981" alt="license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/apivault.svg?style=flat-square&color=8b5cf6" alt="node version"></a>
</p>

---

### Requirements
- **Node.js**: `18.17.0` or higher

---

## Installation

npm Package Manager

```bash
npm install -g apivault
```

Or run on-demand without a global install:

```bash
npx apivault <command>
```

<details>
<summary>Other package managers</summary>

```bash
pnpm add -g apivault
yarn global add apivault
bun install -g apivault
```

</details>

<details>
<summary>Standalone installer scripts (no npm required)</summary>

**macOS / Linux:**
```bash
curl -fsSL https://apivault.tech/install.sh | sh
```

**Windows (PowerShell):**
```powershell
irm https://apivault.tech/install.ps1 | iex
```

Installs into `~/.local/share/apivault` and links `~/.local/bin/apivault` — no root/sudo required.

</details>

---

## Command Reference

| Command | Description |
| :--- | :--- |
| `apivault login` | Authenticate via browser approval |
| `apivault logout` | Revoke session and clear stored token |
| `apivault whoami` | Show the connected user (or service token) and when this device's token expires |
| `apivault link <id\|slug>` | Link current directory to an ApiVault project (`.apivault.json`) |
| `apivault unlink` | Remove local project binding (`.apivault.json`) |
| `apivault keys list` | List all vault keys (masked) |
| `apivault keys add` | Add a new secret (interactive or flags) |
| `apivault keys get <id>` | View key details; add `--reveal` to decrypt |
| `apivault keys update <id>` | Edit a stored key |
| `apivault keys delete <id>` | Delete a key (`-f` to skip prompt) |
| `apivault projects list` | List all available projects with their IDs and slugs |
| `apivault projects use <id\|slug>` | Set active project locally (`.apivault.json`, or `--global`) |
| `apivault projects current` | Display currently active project and its source |
| `apivault run` | Inject secrets into a child process |
| `apivault env export` | Write secrets to a `.env` file |
| `apivault env restore` | Restore `.env` files hidden by `run` |
| `apivault config list\|get\|set\|delete` | Manage local & global CLI defaults (`-l` / `-g`) |
| `apivault logs` | List a project's audit and request logs |
| `apivault logs tail` | Stream new log entries as they arrive |
| `apivault logs get <id>` | Inspect one log entry in full |

**Global flags:** `--json` (machine-readable output), `--timeout <seconds>` (browser approval wait, default 300), `-p, --project <id|slug>` (explicit project override), `-V, --version`, `-h, --help`.

**Environment variables:** `APIVAULT_TOKEN` (service token for headless/CI use — see [Headless Authentication](#headless-authentication-cicd)), `APIVAULT_PROJECT` (default project).

---

## Authentication

```bash
apivault login
```

1. Opens your default browser to an **Approve / Refuse** prompt on ApiVault.
2. If you're not already signed in, you'll be redirected to log in first.
3. The CLI waits in the terminal until approval is detected (override with `--timeout <seconds>`), then saves an API token in your OS credential store (see [Local secrets](#local-secrets)).

```bash
apivault whoami                    # check connection status
apivault logout                    # revoke this device's token
```

### Token expiry

Tokens issued by the approval flow **expire 90 days after they are minted**. `apivault login` prints the expiry date once the connection succeeds, and `apivault whoami` shows it on every run — highlighted as a warning when fewer than 14 days remain:

```bash
apivault whoami
# ✔ Signed in as you@example.com
#   Token expires 12/9/2026.

apivault --json whoami | jq -r .tokenExpiresAt   # ISO date, or null for tokens
                                                 # saved before expiry tracking
```

Once a token lapses, commands report the date it expired instead of a bare `Unauthorized`; run `apivault login` to issue a fresh one. Tokens can also be revoked at any time from **Settings → Sessions & Devices** in the web app.

---

## Headless Authentication (CI/CD)

`apivault login` needs a browser, which a build runner does not have. For pipelines, containers and scheduled jobs, create a **service token** instead — a project-scoped machine credential that carries its own permissions and never represents a person.

Create one in the web app under **your project → Service Tokens**. The value is shown **once**, starts with `av_live_`, and is stored only as a hash — if you lose it, issue a new one.

Set it as `APIVAULT_TOKEN` and every command below works with no login, no `~/.apivault/`, and no project flag:

```bash
export APIVAULT_TOKEN="av_live_..."
apivault whoami
apivault run -- npm start
```

`APIVAULT_TOKEN` takes precedence over a stored device token, so it also works on a developer machine that is already signed in.

### What a service token can do

| Command | Available | Required scope |
| :--- | :--- | :--- |
| `keys list`, `keys get` | ✅ | `keys:read` |
| `keys get --reveal` | ✅ | `keys:reveal` |
| `keys add` | ✅ — flags only, see below | `keys:write` |
| `keys delete <id> -f` | ✅ | `keys:write` |
| `keys update` | ❌ | interactive; needs a terminal |
| `env export` | ✅ | `keys:read` + `keys:reveal` |
| `run -- <command>` | ✅ | `keys:read` + `keys:reveal` |
| `whoami` | ✅ | any |
| `config`, `link`, `unlink` | ✅ | local only |
| `projects list` | ❌ | account-wide, not project-scoped |
| `logs`, `logs tail`, `logs get` | ❌ | audit surface — read it in the web app |
| `login`, `logout` | ❌ | refused while `APIVAULT_TOKEN` is set |

`whoami` reports the machine identity rather than a person, which is the quickest way to confirm a runner picked up the credential you meant:

```bash
apivault whoami
# ✔ Authenticated as service token deploy-bot
#   Project:      acme-api
#   Scopes:       keys:read, keys:reveal
#   Environment:  Production only
```

### Writing keys from a pipeline

With no terminal to prompt on, `keys add` takes every value from flags. A missing one is named as an error instead of hanging the step:

```bash
apivault keys add --name STRIPE_SECRET --key "$NEW_VALUE"   # --environment comes from the pin
```

`--name` and `--key` are always required. `--environment` falls back to the token's pin, and is required when the token is unpinned — there is no safe default, since guessing would put a secret in the wrong environment. `--service` defaults to `Custom` and `--notes` to empty.

`keys delete` needs `-f`. Deleting is irreversible, so with no terminal to confirm on the CLI refuses rather than treating an absent human as a yes:

```bash
apivault keys delete <id> -f
```

`keys update` is interactive for every field and has no flag equivalent, so it cannot run headlessly. To replace a value in a pipeline, `keys delete -f` then `keys add`.

On a project with a **custom vault key**, pass `--vault-key` or set `APIVAULT_KEY`. Any command that decrypts will otherwise stop and say it has no terminal to ask on.

### Environment pinning

A token can be pinned to one environment. When it is, `run` and `env export` use that environment automatically — you do **not** need `--env`, and there is nothing to configure in the container:

```bash
apivault run -- npm start        # loads the token's pinned environment
```

Passing `--env` explicitly still wins, so a token pinned to `Production` that is asked for `Staging` fails loudly rather than quietly reading the wrong secrets. An unpinned token has no default and requires `--env`.

### GitHub Actions

```yaml
- name: Build with vault secrets
  env:
    APIVAULT_TOKEN: ${{ secrets.APIVAULT_TOKEN }}
  run: |
    npx apivault run -- npm run build
```

### Docker

```dockerfile
RUN npm install -g apivault
CMD ["apivault", "run", "--", "node", "server.js"]
```

```bash
docker run -e APIVAULT_TOKEN="av_live_..." myimage
```

### Operational notes

- **Least privilege.** Grant only the scopes the job needs. A build that reads secrets never needs `keys:write`.
- **Every token expires.** Expiry is mandatory; the web app warns as the date approaches. An expired or revoked token reports exactly that, so a red build tells you which it was.
- **IP allowlisting** is available for runners with stable egress addresses. It depends on the proxy headers your deployment trusts — see the [CI/CD guide](https://apivault.tech/docs/ci-cd) before relying on it as a control.
- **Machine exports are announced.** `env export` and the bulk export endpoint notify the project's owners and admins, naming the token.
- **Revocation is immediate** and lives on the project's Service Tokens page — `apivault logout` does not apply to service tokens and will refuse to run.

---

## Managing Projects & Local Directory Bindings

```bash
apivault projects list             # list all available projects (ID and slug)
apivault projects use <id|slug>    # bind current directory to a project (.apivault.json)
apivault link <id|slug>            # shortcut to bind current directory
apivault projects current          # check active project and resolution source
apivault unlink                    # remove local project binding
```

Anywhere a project is named — the `-p/--project` flag, `APIVAULT_PROJECT`, or the `project` config value — you can pass either the project **ID** or its **slug** (the name in your project URL, `apivault.tech/<username>/<slug>`). `apivault projects list` prints both.

For commands that require a project context, the CLI resolves the active project in this order:
1. `--project <id|slug>` or `-p <id|slug>` flag (available on all commands)
2. `APIVAULT_PROJECT` environment variable
3. Local directory configuration (`.apivault.json`, `.apivaultrc`, `apivault.json`)
4. Global default project (`apivault projects use <id|slug> --global` or `~/.apivault/config.json`)


---

## Managing API Keys

```bash
apivault keys list                 # list stored keys (masked)
apivault keys add                  # interactive wizard
apivault keys get <id>             # show key metadata
apivault keys get <id> --reveal    # decrypt and display raw value
apivault keys update <id>          # edit key attributes
apivault keys delete <id>          # confirm, then delete
apivault keys delete <id> -f       # skip confirmation
```

For automation, pass all values as flags:

```bash
apivault keys add \
  --name STRIPE_SECRET \
  --service Stripe \
  --environment Production \
  --key "sk_live_51M..." \
  --notes "Production payment gateway"
```

### Custom Encryption Vault Key

Projects with a **custom vault key** (set on the project's Vault Encryption page) need the vault key for encrypt/decrypt operations. The CLI resolves it in order:

1. `--vault-key "<vault-key>"` flag
2. `APIVAULT_KEY` environment variable (pipelines and one-off commands)
3. A `${env:NAME}` reference in `.apivault.json`
4. The key saved for this project with `apivault config set vaultKey`
5. Interactive hidden prompt, which offers to save the key for the project

Projects using default encryption need no vault key.

Vault keys belong to a project, so they are saved per project, in your OS credential store:

```bash
apivault config set vaultKey      # run in the project folder; prompts with hidden input
apivault config get vaultKey      # masked, and whether one is saved
apivault config delete vaultKey   # removes this project's saved key
```

To use an environment variable instead, reference it from `.apivault.json`. The file holds only the name, so it stays safe to commit. Use single quotes so your shell doesn't expand it:

```bash
apivault config set vaultKey '${env:APIVAULT_KEY_MY_APP}'
setx APIVAULT_KEY_MY_APP "your-vault-key"   # Windows; or export it from your shell profile
```

Don't set `APIVAULT_KEY` itself permanently: every project would receive it, and projects with a different vault key fail with "That vault key is incorrect."

`apivault run` doesn't pass `APIVAULT_KEY`, `APIVAULT_KEY_*` variables, or the variable `.apivault.json` names to the command it starts.

#### Attempt limits

Wrong vault keys are throttled server-side: **10 failed attempts per 15 minutes**, counted per user and per source address. Only requests that actually carry a vault key count, and a correct key clears the counter, so normal use never reaches the limit. Once it trips, the API answers `429` with a `Retry-After` header and the CLI reports how long to wait — re-running the same wrong key only extends the wait.

---

## Injecting Secrets (`apivault run`)

Decrypt all keys for an environment and inject them as environment variables into a child process — **no `.env` files written to disk**.

```bash
# Inject Production secrets into npm start
apivault run --env Production -- npm start

# Inject Staging secrets into Python / Node
apivault run --env Staging -- python main.py
```

| Flag | Description |
| :--- | :--- |
| `--env <name>` | Vault environment to pull secrets from |
| `--vault-key <vault-key>` | Custom encryption vault key |

During execution, existing local `.env` files are temporarily renamed to `*.apivault-run-hidden` to prevent framework conflicts, and automatically restored on exit. If restoration fails (e.g. process killed), run `apivault env restore`.

Save defaults to skip flags:

```bash
apivault config set run.env Production
apivault config set run.command "npm run dev"
apivault run                               # uses saved defaults
```

---

## Dotenv Management (`apivault env`)

Export decrypted secrets to local `.env` files for frameworks that require them (Next.js, Vite, Docker Compose, etc.):

```bash
apivault env export --env Production               # write to .env (merge)
apivault env export --env Staging -o .env.local     # custom output path
apivault env export --env Production --force        # overwrite instead of merge
```

| Flag | Description |
| :--- | :--- |
| `--env <name>` | Vault environment to export |
| `-o, --output <path>` | Target file (default: `.env`) |
| `-f, --force` | Replace file entirely instead of merging |
| `--vault-key <vault-key>` | Custom encryption vault key |

Restore hidden dotenv backups:

```bash
apivault env restore                        # current directory
apivault env restore -C /path/to/project    # specify project directory
```

---

## Local & Global Configuration
 
Manage CLI defaults stored per-project in `.apivault.json` or globally in `~/.apivault/config.json`:
 
```bash
apivault config list                       # view active merged config (shows local vs global)
apivault config list --local               # view only local project config
apivault config list --global              # view only global user config
apivault config get run.command            # read a resolved value
apivault config set --local run.env Dev    # set local project default environment
apivault config set --local run.command "npm run dev"
apivault config set --global run.env Prod  # set global default environment
apivault config set vaultKey               # save this project's vault key in the OS credential store
apivault config delete --local run.env     # remove a local value
```

Known keys: `project`, `run.command`, `run.env`, `vaultKey`. Explicit flags and local configs always take precedence. `vaultKey` is never written to a config file; see [Custom Encryption Vault Key](#custom-encryption-vault-key).

### Local secrets

The login token and saved vault keys are kept in your operating system's credential store: Keychain on macOS, Credential Manager on Windows, and the Secret Service (libsecret) on Linux. Where none is available, such as a headless Linux machine, they go to `~/.apivault/secrets.json` with owner-only permissions. Set `APIVAULT_NO_KEYCHAIN=1` to use the file on purpose.

Upgrading from 1.7 or earlier moves the token from `~/.apivault/token.json` and the vault key from `~/.apivault/config.json` into the credential store the first time the CLI runs. The old vault key is adopted by each project it works for; remove it with `apivault config delete vaultKey --global`.


---

## Audit & Request Logs (`apivault logs`)

Every request against a project — from the web app, the CLI, or an MCP agent — is recorded with
its status, actor, and duration. `apivault logs` reads that history without leaving the terminal.

```bash
# Most recent entries for the active project
apivault logs

# Narrow it down
apivault logs --status error --source mcp
apivault logs --status 404 --method POST
apivault logs --event-type KEY_REVEALED --date 2026-09-01 --end-date 2026-09-10
apivault logs --search "/api/keys" -n 100

# Follow new entries as they arrive (Ctrl+C to stop)
apivault logs --follow
apivault logs tail --source cli

# Inspect one entry in full, including its details payload
apivault logs get <log-id>
```

| Flag | Description |
| :--- | :--- |
| `-n, --limit <n>` | Entries to fetch (default 50, max 1000) |
| `--page <n>` | Page through results (default 1) |
| `-f, --follow` | Stream new entries in real time |
| `--status <s>` | `success`, `error`, or an HTTP code such as `200` / `404`. Repeatable |
| `--source <s>` | `cli`, `mcp`, `web`, `api`, `service` (service tokens), or `integration` (automatic Vercel and Supabase work) |
| `--method <m>` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE` |
| `--event-type <t>` | e.g. `KEY_REVEALED`, `KEY_ROTATED`, `KEY_CREATED` |
| `--user <userId>` | Restrict to one actor |
| `--key <idOrName>` | Entries touching one stored key |
| `--date` / `--end-date` | `YYYY-MM-DD` bounds |
| `--search <query>` | Matches log ID, endpoint, method, source, IP, event type, or actor |

`apivault logs get <id>` accepts an ID prefix, so the shortened ID shown in a table is enough.

With `--json`, `logs` prints the full response object (entries plus pagination), while `--follow`
emits one JSON object per line as entries arrive, suitable for piping into a log forwarder:

```bash
apivault --json logs -f | jq -c '{t: .createdAt, s: .status, e: .endpoint}'
```

A `--follow` stream rides out transient network errors, but stops and reports if the token has
expired or been revoked, the project became inaccessible, or a filter was rejected — so a broken
stream is never mistaken for a quiet one.

---

## JSON Output

Pass `--json` to any command for structured output suitable for `jq` or scripts:

```bash
apivault --json keys list | jq '.[] | {id: .id, name: .name}'
apivault --json keys get <id> --reveal | jq -r .rawKey | clip
```

---

## Security

| Layer | Detail |
| :--- | :--- |
| **Transport** | HTTPS with token-header authentication |
| **Local storage** | Login token and vault keys in the OS credential store (Keychain, Credential Manager, Secret Service); `config.json` holds no secrets |
| **Process isolation** | Secrets exist only in child-process memory during `apivault run` — nothing written to disk |
| **Token lifetime** | Device tokens expire 90 days after approval, and can be revoked early from **Settings → Sessions & Devices** |
| **Throttling** | Wrong vault keys are rate limited server-side (10 per 15 minutes, per user and source address) |

---

## 🤖 AI Agent Skill

If you use AI coding assistants (Cursor, Claude Desktop, Claude Code, Windsurf, Antigravity), install the official [ApiVault Skill](https://github.com/ApiVault-tech/apivault-skill) into your workspace:

```bash
git clone https://github.com/ApiVault-tech/apivault-skill.git .agents/skills/apivault
```

This equips your AI agents with native runbooks, MCP configuration templates, and automated workflows to manage credentials without leaking secrets.

---

## Documentation & Links

- **Website**: [apivault.tech](https://apivault.tech)
- **CLI Docs**: [apivault.tech/docs/cli](https://apivault.tech/docs/cli)
- **AI Agent Skill**: [github.com/ApiVault-tech/apivault-skill](https://github.com/ApiVault-tech/apivault-skill)
- **Issues**: [GitHub Issues](https://github.com/ApiVault-tech/apivault/issues)

## License

[MIT](LICENSE)
