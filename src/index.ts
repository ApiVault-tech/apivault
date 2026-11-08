import { Command } from "commander";
import { runLogin, runLogout, runWhoami } from "./connect";
import { registerKeysCommand } from "./commands/keys";
import { registerRunCommand } from "./commands/run";
import { registerConfigCommand } from "./commands/config";
import { registerEnvCommand } from "./commands/env";
import { registerProjectsCommand } from "./commands/projects";
import { registerLogsCommand } from "./commands/logs";
import { reportError } from "./ui/format";
import { isTokenExpired, readToken } from "./config";
import { migrateGlobalVaultKey } from "./vault-key";
import pkg from "../package.json";

const program = new Command();

program
  .name("apivault")
  .description(pkg.description)
  .version(pkg.version)
  .option("--json", "Emit machine-readable JSON output")
  .option("-p, --project <id>", "Target project ID or slug")
  .option(
    "--timeout <seconds>",
    "Seconds to wait for browser approval during login",
    (v) => parseInt(v, 10),
  );

// Top-level commands --------------------------------------------------------

program
  .command("login")
  .description("Open a browser to approve this CLI's connection to your account")
  .action(async () => {
    try {
      await runLogin(program.opts());
    } catch (err) {
      reportError(err, Boolean(program.opts().json));
      process.exitCode = 1;
    }
  });

program
  .command("logout")
  .description("Revoke this device's token and sign out")
  .action(async () => {
    try {
      await runLogout();
    } catch (err) {
      reportError(err, Boolean(program.opts().json));
      process.exitCode = 1;
    }
  });

program
  .command("whoami")
  .description("Show the currently signed-in user")
  .action(async () => {
    try {
      await runWhoami(program.opts());
    } catch (err) {
      reportError(err, Boolean(program.opts().json));
      process.exitCode = 1;
    }
  });

program
  .command("link <id>")
  .description("Link current directory to an ApiVault project (.apivault.json)")
  .action(async (id: string) => {
    try {
      const { setConfigValue } = await import("./config");
      const { printJson, printSuccess, green, cyan } = await import("./ui/format");
      const result = setConfigValue("project", id, { scope: "local" });
      if (Boolean(program.opts().json)) {
        printJson({ project: id, scope: "local", file: result.targetPath, set: true });
        return;
      }
      printSuccess(`Linked current directory to project ${green(id)} ${cyan(`(${result.targetPath})`)}.`);
    } catch (err) {
      reportError(err, Boolean(program.opts().json));
      process.exitCode = 1;
    }
  });

program
  .command("unlink")
  .description("Remove local project binding (.apivault.json) from current directory")
  .action(async () => {
    try {
      const { unlinkLocalProject } = await import("./config");
      const { printJson, printSuccess, dim } = await import("./ui/format");
      const unlinked = unlinkLocalProject();
      if (Boolean(program.opts().json)) {
        printJson({ unlinked });
        return;
      }
      if (unlinked) {
        printSuccess("Removed local project configuration (.apivault.json).");
      } else {
        process.stdout.write(dim("No local project configuration found in this directory.\n"));
      }
    } catch (err) {
      reportError(err, Boolean(program.opts().json));
      process.exitCode = 1;
    }
  });

// Subcommand groups ---------------------------------------------------------

registerKeysCommand(program);
registerRunCommand(program);
registerConfigCommand(program);
registerEnvCommand(program);
registerProjectsCommand(program);
registerLogsCommand(program);

// When invoked with no arguments at all, print a short status hint. Any
// unrecognized command is left to commander, which exits non-zero with a
// helpful "unknown command" message.
// CLI 1.7 and earlier kept one vault key, in plain text, in
// ~/.apivault/config.json. Move it into the secret store before any command
// reads the config.
try {
  migrateGlobalVaultKey();
} catch {
  // Never block a command on the migration; it runs again next time.
}

const rawArgs = process.argv.slice(2);
if (rawArgs.length === 0) {
  const signedIn = Boolean(readToken());
  const status = !signedIn
    ? "Not signed in — run `apivault login`.\n"
    : isTokenExpired()
      ? "This device's token has expired — run `apivault login` to reconnect.\n"
      : "Signed in.\n";
  process.stdout.write(
    "ApiVault CLI\n\n" + status + "Run `apivault --help` to see all commands.\n",
  );
  process.exit(0);
}

program.parseAsync(process.argv).catch((err) => {
  reportError(err, false);
  process.exit(1);
});
