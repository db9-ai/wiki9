import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { syncCommand } from "./commands/sync.js";
import { searchCommand } from "./commands/search.js";
import { indexCommand } from "./commands/index.js";
import { statusCommand } from "./commands/status.js";
import { displayText } from "./utils/output.js";

const program = new Command();

program
  .name("wiki9")
  .description("Agent-native LLM Wiki powered by DB9")
  .version("0.1.2");

program
  .command("init")
  .description("Initialize a new wiki project")
  .requiredOption("--db <id>", "DB9 database ID")
  .option("--token <token>", "DB9 access token (prefer WIKI9_TOKEN or db9 login)")
  .option("--name <name>", "Wiki name")
  .action(async (opts) => {
    await initCommand(opts.db, opts.token, opts.name);
  });

program
  .command("sync")
  .description("Sync local wiki to DB9 (fs9 backup + vector index)")
  .option("--full", "Rescan all local content instead of only syncing changed content")
  .option("--prune", "With --full, rebuild remote content from local files and remove remote-only data")
  .action(async (opts) => {
    await syncCommand({ full: opts.full, prune: opts.prune });
  });

program
  .command("search <query>")
  .description("Semantic search across wiki pages")
  .option("--json", "Return structured wiki data")
  .action(async (query, opts) => {
    await searchCommand(query, { json: opts.json });
  });

program
  .command("index")
  .description("List all wiki pages")
  .option("--json", "Return structured wiki data")
  .action(async (opts) => {
    await indexCommand({ json: opts.json });
  });

program
  .command("status")
  .description("Show wiki statistics")
  .option("--json", "Return structured wiki data")
  .action(async (opts) => {
    await statusCommand({ json: opts.json });
  });

program.parseAsync().catch((error: unknown) => {
  console.error(displayText(error instanceof Error ? error.message : "Command failed."));
  process.exitCode = 1;
});
