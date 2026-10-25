/**
 * Standalone preview server for development.
 *
 *   npm run preview -- --dir ~/.pi/agent/sessions --port 4789
 *
 * This does not need pi: it serves the same dashboard the extension serves.
 */

import os from "node:os";
import path from "node:path";

import { startWebServer } from "../src/web/server.ts";

interface Args {
  dirs: string[];
  port: number;
  open: boolean;
}

function parse(argv: string[]): Args {
  const args: Args = {
    dirs: [],
    port: Number(process.env.PORT ?? 4789),
    open: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--dir" || token === "-d") {
      const value = argv[++i];
      if (value) args.dirs.push(path.resolve(value));
    } else if (token.startsWith("--dir=")) {
      args.dirs.push(path.resolve(token.slice("--dir=".length)));
    } else if (token === "--port" || token === "-p") {
      args.port = Number(argv[++i] ?? 4789);
    } else if (token.startsWith("--port=")) {
      args.port = Number(token.slice("--port=".length));
    } else if (token === "--open" || token === "-o") {
      args.open = true;
    } else if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (args.dirs.length === 0) {
    args.dirs = [
      process.env.PI_CODING_AGENT_SESSION_DIR ?? path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "sessions"),
    ];
  }
  return args;
}

function printHelp(): void {
  console.log(`pi token viewer — preview server

Usage: npm run preview -- [options]

  -d, --dir <path>    Session directory (repeatable; defaults to pi's session dir)
  -p, --port <port>   Port to bind on 127.0.0.1 (default 4789, 0 = random)
  -o, --open          Open the dashboard in your browser
  -h, --help          Show this help
`);
}

const args = parse(process.argv.slice(2));
const server = await startWebServer({ dirs: args.dirs, port: args.port, open: args.open });

console.log(`pi token viewer running at ${server.url}`);
console.log(`reading sessions from ${server.dirs.join(", ")}`);
console.log("press Ctrl+C to stop");

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
