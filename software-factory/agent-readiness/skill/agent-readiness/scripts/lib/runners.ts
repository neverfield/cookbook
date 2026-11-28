// The programs that run a repo's own code, by how a command line names them. The shell guard
// (guard.ts) refuses them on the host during an audit, and the eval grader
// (support/evals/lib/shell.ts) blames a run for them, so both read this one table. It imports
// nothing, so the guard hook still loads only itself, session.ts and this file.

// Words in front of a command that run the rest of the line as the command.
export const WRAPPERS = new Set(["time", "nohup", "command", "exec", "builtin", "nice", "sudo", "doas", "xargs", "stdbuf", "caffeinate"]);
// npm subcommands, with npm's own aliases and typos, that run a script or an install.
export const NPM_RUNS = new Set(["test", "t", "tst", "run", "run-script", "rum", "urn", "start", "stop", "restart", "ci", "clean-install", "install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isntal", "isntall", "add", "it", "cit", "install-test", "install-ci-test", "clean-install-test", "exec", "x", "rebuild", "rb", "explore", "pack", "publish"]);
// pnpm, Yarn and Bun run any other first word as a script, so these are the ones that don't.
export const PM_HARMLESS = new Set(["--version", "-v", "-V", "--help", "-h", "help", "info", "view", "why", "list", "ls", "config", "outdated", "audit", "store", "bin", "root", "licenses", "env"]);
// Deno subcommands that run code.
export const DENO_RUNS = new Set(["test", "run", "task", "bench", "compile", "install"]);
// Programs that run the repo's code whatever follows them.
export const RUNNERS = new Set(["npx", "pnpx", "bunx", "pytest", "py.test", "tox", "nox", "make", "gmake", "tsc", "vitest", "jest", "mocha", "ava", "tap", "playwright", "cypress", "eslint", "biome", "prettier", "ruff", "mypy", "pyright", "flake8", "black", "rspec", "phpunit", "rake", "gradle", "gradlew", "mvn", "mvnw", "turbo", "nx", "lerna", "tsx", "ts-node", "jasmine", "karma", "nodemon"]);
// Toolchains that run the repo's code only through one of BUILD_SUBS (and `uv pip`).
export const BUILD_TOOLS = new Set(["cargo", "go", "dotnet", "swift", "uv", "poetry", "pipenv", "pdm", "hatch", "rye", "composer", "bundle", "mix"]);
export const BUILD_SUBS = new Set(["test", "run", "build", "bench", "generate", "vet", "check", "exec", "task", "install", "sync", "compile"]);
export const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
