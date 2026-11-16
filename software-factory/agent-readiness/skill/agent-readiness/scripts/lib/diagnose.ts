import type { Diagnosis } from "./types.ts";

const PORTS: Record<string, string> = {
  "5432": "Postgres",
  "3306": "MySQL",
  "6379": "Redis",
  "27017": "MongoDB",
  "9200": "Elasticsearch",
  "5672": "RabbitMQ",
  "9092": "Kafka",
  "11211": "Memcached",
};

// The words that show the output itself named the service on a port, not just the port.
const NAMED: Record<string, RegExp> = {
  "5432": /postgres/i,
  "3306": /mysql|mariadb/i,
  "6379": /redis/i,
  "27017": /mongo/i,
  "9200": /elasticsearch/i,
  "5672": /rabbitmq|amqp/i,
  "9092": /kafka/i,
  "11211": /memcache/i,
};

// How report text names the service a refused connection points at: by name only when the output
// named it, otherwise by its port.
export function serviceLabel(d: Diagnosis, unnamed: (port: string) => string): string {
  const port = d.detail.match(/port (\d+)/)?.[1];
  if (!port) return d.service ?? "a service";
  return d.serviceNamed && d.service ? `${d.service} on port ${port}` : unnamed(port);
}

const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/;

// The test totals a runner prints, so the report can say "82 of 82 tests" instead of "passed".
// Covers node --test (tap and spec), bun test, vitest, jest, mocha, pytest and unittest; null when none match.
export function testCounts(output: string): { passed: number; failed: number; total: number } | null {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  const num = (re: RegExp) => {
    const all = [...text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))];
    return all.length ? Number(all[all.length - 1][1]) : null;
  };
  const nodePass = num(/^\s*[#\u2139] pass (\d+)\s*$/m);
  if (nodePass !== null) {
    const failed = num(/^\s*[#\u2139] fail (\d+)\s*$/m) ?? 0;
    return { passed: nodePass, failed, total: num(/^\s*[#\u2139] tests (\d+)\s*$/m) ?? nodePass + failed };
  }
  const bunRan = num(/^Ran (\d+) tests? across \d+ files?\./m);
  if (bunRan !== null) {
    const failed = num(/^\s*(\d+) fail\s*$/m) ?? 0;
    return { passed: num(/^\s*(\d+) pass\s*$/m) ?? bunRan - failed, failed, total: bunRan };
  }
  const vitest = [...text.matchAll(/Tests\s+(?:(\d+) failed \|\s*)?(\d+) passed[^(\n]*\((\d+)\)/g)].pop();
  if (vitest) return { passed: Number(vitest[2]), failed: Number(vitest[1] ?? 0), total: Number(vitest[3]) };
  const jest = [...text.matchAll(/Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(?:\d+ todo, )?(\d+) passed, (\d+) total/g)].pop();
  if (jest) return { passed: Number(jest[2]), failed: Number(jest[1] ?? 0), total: Number(jest[3]) };
  const mochaPass = num(/^\s*(\d+) passing\b/m);
  if (mochaPass !== null) {
    const failed = num(/^\s*(\d+) failing\b/m) ?? 0;
    return { passed: mochaPass, failed, total: mochaPass + failed };
  }
  const pytest = [...text.matchAll(/(?:(\d+) failed, )?(\d+) passed(?:, \d+ \w+)* in [\d.]+s/g)].pop();
  if (pytest) return { passed: Number(pytest[2]), failed: Number(pytest[1] ?? 0), total: Number(pytest[2]) + Number(pytest[1] ?? 0) };
  const ran = num(/^Ran (\d+) tests? in /m);
  if (ran !== null) {
    const failed = (num(/FAILED \((?:failures=(\d+))/m) ?? 0) + (num(/FAILED \([^)]*errors=(\d+)/m) ?? 0);
    return { passed: ran - failed, failed, total: ran };
  }
  return null;
}

// TLS interception, proxies and resets show up as these, not only as DNS failures. Returns what
// failed in plain words, or null.
const NETWORK: { re: RegExp; detail: string }[] = [
  { re: /There was an issue establishing a connection while requesting https?:\/\/\S+|Failed to (fetch|download) (font|`[^`\n]+` from Google Fonts)|request to https?:\/\/fonts\.(googleapis|gstatic)\.com\S* failed/i, detail: "a failed font download on the network" },
  { re: /Error when performing the request to https?:\/\/\S+|ERR_PNPM_META_FETCH_FAIL|npm (error|ERR!) network\b|YN0001[^\n]*(RequestError|getaddrinfo|ENOTFOUND|ECONNREFUSED)/, detail: "an unreachable package registry on the network" },
  // The registries of the other ecosystems, as each tool reports a refused or unreachable host. A
  // missing version reads differently (Maven's "Could not find artifact", NuGet's NU1102, Go's
  // "unknown revision", Bundler's "Could not find gem"), so it stays the repo's failure.
  // Bundler: "Bundler::HTTPError Could not fetch specs from https://rubygems.org/ ... SSL_connect
  // returned=1", or "Could not reach host index.rubygems.org. Check your network connection".
  { re: /Bundler::HTTPError|Could not fetch specs from https?:\/\/\S+|Gem::RemoteFetcher::(FetchError|UnknownHostError)|SSL_connect returned=\d|Could not reach host [\w.-]+\.\s+Check your network connection/, detail: "an unreachable package registry on the network" },
  // Composer boxes its message and wraps it mid-word, so only the curl code and URL are reliable.
  { re: /curl error (5|6|7|28|35|52|56) while downloading https?:\/\//, detail: "an unreachable package registry on the network" },
  // NuGet: "error NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json".
  { re: /\bNU1301\b|Unable to load the service index for source https?:\/\/\S+/, detail: "an unreachable package registry on the network" },
  // Maven: a transfer that failed on the connection, not on a missing artifact. With -q only the
  // last line shows; the dependency plugin is Maven's own, so failing to find it means the
  // repository wasn't reached. The Maven Wrapper downloads Maven with wget.
  { re: /Could not transfer (artifact|metadata) [^\n]* from\/to [^\n]*\(https?:\/\/[^)\s]+\): (Remote host terminated the handshake|Connection reset|Connect to [^\n]* failed|[\w.-]+(: (Name or service not known|Temporary failure in name resolution))?$)|No plugin found for prefix 'dependency' in the current project|wget: Failed to fetch https?:\/\//m, detail: "an unreachable package registry on the network" },
  // Maven while it reads the POMs, as google/gson's build extension did: the transfer error itself
  // shows only with -X, so "Failed to read artifact descriptor" is all there is. A version that
  // doesn't exist reads "The POM for ... is missing" and "could not be resolved" instead.
  { re: /Failed to read artifact descriptor for \S+/, detail: "an unreachable package registry on the network" },
  // Gradle: "Could not GET 'https://repo.maven.apache.org/...'"; a missing version is "Could not find".
  { re: /Could not GET '[^']+'/, detail: "an unreachable package registry on the network" },
  // Go: `Get "https://proxy.golang.org/...": EOF`, or a dial, TLS or reset error after the URL.
  { re: /Get "https?:\/\/[^"]+": (EOF|dial tcp|net\/http: TLS handshake timeout|read tcp [^\n]*connection reset|tls: |x509: )/, detail: "an unreachable package registry on the network" },
  { re: /java\.net\.(UnknownHostException|ConnectException|NoRouteToHostException)|Remote host terminated the handshake|java\.net\.SocketException: (Connection reset|Network is unreachable)/, detail: "a network connection failed" },
  // uv and other Rust tools: "Caused by: dns error" / "failed to lookup address information: Try again".
  { re: /failed to lookup address information|Caused by: dns error/, detail: "it tried to reach the network" },
  { re: /\bcurl: \((5|6|7|28|35|52|56)\)/, detail: "it tried to reach the network" },
  { re: /ProxyError|407 Proxy Authentication|tunneling socket could not be established|proxy[^\n]{0,40}(refused|error|failed)/i, detail: "a proxy error on the network" },
  // uv and other reqwest clients: "error sending request for url (https://files.pythonhosted.org/...)"
  // ending in "tls handshake eof", which is a host that dropped the connection, not a bad certificate.
  { re: /error sending request for url[\s\u2502|]*\(https?:\/\/[^)\s]+\)(?![\s\S]*(invalid peer certificate|UnknownIssuer|certificate verify failed))/, detail: "an unreachable package registry on the network" },
  { re: /CERT_|certificate verify failed|invalid peer certificate|unable to (get|verify) (the )?(local issuer|first) certificate|self[- ]signed certificate|SSLError|SSL: [A-Z_]+|ERR_SSL|SSL routines|tlsv1 alert|TLS handshake|Client network socket disconnected before secure TLS/i, detail: "a TLS or certificate error on the network" },
  { re: /ENOTFOUND|EAI_AGAIN|getaddrinfo|Temporary failure in name resolution|Could not resolve host/, detail: "it tried to reach the network" },
  { re: /ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|Network is unreachable|socket hang up|\bfetch failed\b|Connection reset by peer|Failed to connect to|Max retries exceeded with url|NewConnectionError|ReadTimeoutError|request to https?:\/\/\S+ failed|ECONNREFUSED (?!127\.0\.0\.1|::1|localhost)[\d.]+:\d+|All attempts to connect to [\w.-]+ failed/, detail: "a network connection failed" },
];

// A home or cache directory the audit's user can't write, such as one a setup step run as root
// left behind. Poetry reports it as "All attempts to connect to pypi.org failed" with the
// PermissionError only in its verbose output; npm says its cache holds root-owned files.
const PERMISSION = /\bEACCES\b|\bEPERM\b|PermissionError|Permission denied/;
const HOME_OR_CACHE = /(\/tmp\/home\b|\/root\b|\/home\/[^/\s'"]+\/\.|\.cache\/|\/\.npm\b|\/\.bun\/|\/\.yarn\/berry|pypoetry|corepack|ms-playwright|\/\.local\/)/;

export function permissionLimit(output: string): string | null {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  if (/cache folder contains root-owned files/.test(text)) return "the npm cache in the home directory belongs to another user";
  if (/Connection broken: PermissionError\(13/.test(text)) return "a permission error on a cache or home directory, which the tool reported as a failed connection";
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!PERMISSION.test(lines[i])) continue;
    const near = lines.slice(Math.max(0, i - 2), i + 5).join("\n");
    const path = near.match(new RegExp(String.raw`(?:^|[\s'"=(])(\/[^\s'",)]*${HOME_OR_CACHE.source}[^\s'",)]*)`, "m"))?.[1];
    if (path) return `the audit's user can't write ${path.replace(/[:.]+$/, "")}, a home or cache directory`;
  }
  return null;
}

// The Python the image has doesn't satisfy the project's requires-python, as pip, uv and Poetry say it.
export function pythonMismatch(output: string): string | null {
  const m =
    output.match(/requires a different Python: [\d.]+ not in '([^']+)'/) ??
    output.match(/No interpreter found for Python ([^\s]+)/) ??
    output.match(/current Python version \([\d.]+\) does not satisfy Python([^\s,]+)/) ??
    output.match(/Python version [\d.]+ is not supported by the project \(([^)]+)\)/) ??
    output.match(/Current Python version \([\d.]+\) is not allowed by the project \(([^)]+)\)/);
  return m ? `Python ${m[1].replace(/^\s*/, "")} is not installed` : null;
}

// Playwright's browsers are a separate download (`playwright install`) that the image doesn't have.
const PLAYWRIGHT = /Executable doesn't exist at [^\n]*ms-playwright|Looks like Playwright (?:Test or Playwright )?was just installed or updated|Please run the following command to download new browsers/;

export function networkFailure(output: string): string | null {
  return NETWORK.find((n) => n.re.test(output))?.detail ?? mirrorRefused(output);
}

// A package mirror or registry answering an HTTP error, such as apt's "403  Forbidden" from
// deb.debian.org behind a firewall, or a 5xx or rate limit from npm or PyPI. 401 is missing registry
// credentials and 404 can be a typo in the repo's own dependencies, so neither is here.
const STATUS = String.raw`(?<status>403|407|429|5\d\d)`;
const URL_ = String.raw`(?<url>https?:\/\/[^\s"'\\]+)`;
const REASON = String.raw`(?:Forbidden|Proxy Authentication Required|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out|Client Error|Server Error)`;
const MIRROR: RegExp[] = [
  // apt: "E: Failed to fetch <url>  403  Forbidden [IP: ...]"; yarn: "<url>: Request failed \"403 Forbidden\""
  new RegExp(String.raw`${URL_}[^\n]*?[\s"]${STATUS}\s+${REASON}`),
  // apt update: "Err:1 <url> bookworm InRelease" with "  403  Forbidden" on the next line
  new RegExp(String.raw`Err:\d+\s+${URL_}[^\n]*\n\s+${STATUS}\s+${REASON}`),
  // npm: "403 Forbidden - GET <url>"; requests: "403 Client Error: Forbidden for url: <url>"
  new RegExp(String.raw`\b${STATUS}\b[^\n]{0,40}?${REASON}[^\n]*?${URL_}`),
  // pip: "HTTP error 403 while getting <url>"; pnpm: "ERR_PNPM_FETCH_403  GET <url>"
  new RegExp(String.raw`(?:HTTP error ${STATUS} while getting|ERR_PNPM_FETCH_${STATUS.replace("status", "pnpm")}\s+GET)\s+${URL_}`),
];

export function mirrorRefused(output: string): string | null {
  for (const re of MIRROR) {
    const m = re.exec(output);
    if (!m?.groups) continue;
    let host = "the mirror";
    try {
      host = new URL(m.groups.url.replace(/[:.,;)]+$/, "")).hostname;
    } catch {
      // keep the generic name
    }
    return `a package mirror refusing the download (HTTP ${m.groups.status ?? m.groups.pnpm} from ${host})`;
  }
  return null;
}

// Node, TypeScript and Python name a missing module one way; bundlers and Vite another. The first
// group that matched is the module.
const MISSING_MODULE = [
  /Cannot find (?:module|package) '([^'\n]+)'/,
  /ModuleNotFoundError: No module named '([^'\n]+)'/,
  /ERR_MODULE_NOT_FOUND[^\n']*'([^'\n]+)'/,
  /Could not resolve ["']([^"'\n]+)["']/,
  /[Ff]ailed to resolve (?:entry for package|import) ["']([^"'\n]+)["']/,
  /Module not found: Error: Can't resolve '([^'\n]+)'/,
  /["']([^"'\n]+)["'] is imported by [^\n]+, but could not be resolved/,
];

// Check marks as escapes: U+2714 is an emoji code point, which the skill's files never contain.
const PASSED_LINE = /^\s*(ok \d+\b|[\u2713\u2714\u221a]|PASS\s|PASSED\b|test [^\n]* \.\.\. ok$)/;

// The part of the output that explains the failure: the TAP `not ok` blocks, the first failing
// jest, vitest or pytest section, or else the output without the lines of tests that passed, so a
// passing test named "handles network errors" never reads as a network failure.
export function failingPart(output: string): string {
  const lines = output.split("\n");
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/^(\s*)not ok \d+/);
    if (!head) continue;
    const indent = head[1].length;
    const block = [lines[i]];
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (next.trim() !== "" && (next.match(/^\s*/)?.[0].length ?? 0) <= indent) break;
      block.push(next);
      i++;
    }
    blocks.push(block.join("\n"));
  }
  if (blocks.length) return blocks.join("\n");
  const section = lines.findIndex((l) => /^\s*(FAIL\s|\u25cf\s|[\u00d7\u2717\u2715]\s|=+ (FAILURES|ERRORS) =+$)/.test(l));
  const kept = (section >= 0 ? lines.slice(section) : lines).filter((l) => !PASSED_LINE.test(l));
  return kept.join("\n");
}

// Tools wrap long messages across lines and inside JSON strings; matching runs on a copy with the
// lines joined as well as on the lines themselves.
function unwrap(text: string): string {
  return text.replace(/\\n/g, "\n").replace(/^[\s│|>]+/gm, (m) => m.replace(/[│|>]/g, "")).replace(/\s*\n\s*/g, " ");
}

export const BUNDLE_GAP = "is not installed by bundle install";

// A tool or setting this machine lacks, as package managers, Node and git say it.
function toolchainGap(text: string): string | null {
  const env = text.match(/env: ['‘"]?([\w.+-]+)['’"]?: No such file or directory/);
  if (env) return `${env[1]} is not installed`;
  const spawn = text.match(/\bspawn ([\w.+-]+) ENOENT\b/);
  if (spawn) return `${spawn[1]} is not installed`;
  // Ruby starting a program that isn't there, as pandoc-ruby does for sinatra's PandocTest. A missing
  // file reads the same, so only one whose backtrace starts a process counts.
  const rubySpawn = text.match(/(?:Errno::ENOENT: )?No such file or directory - ([A-Za-z][\w+-]*)(?: \(Errno::ENOENT\))?[ \t]*\n(?:[^\n]*\n){0,2}?[^\n]*in '(?:Process\.spawn|Kernel#(?:spawn|system|exec|`)|Open3\.\w+|IO\.popen)'/);
  if (rubySpawn) return `${rubySpawn[1]} is not installed`;
  // `bundle exec` for a gem the install left out: Bundler is there, the gem isn't in the bundle.
  const notBundled = text.match(/\bbundler: command not found: ([\w.+-]+)/);
  if (notBundled) return `${notBundled[1]} ${BUNDLE_GAP}`;
  // Composer: "require ext-mongodb ^2.5 -> it is missing from your system".
  const ext = text.match(/\bext-([\w-]+)\b[^\n]*?it is missing from your system/);
  if (ext) return `PHP's ${ext[1]} extension (ext-${ext[1]}) is not installed`;
  const pnpmNode = text.match(/This version of pnpm requires at least Node\.js v?([\d.]+)/);
  if (pnpmNode) return `Node ${pnpmNode[1]} or later is not installed`;
  const engine = text.match(/The engine "node" is incompatible with this module\. Expected version "([^"]+)"/) ?? text.match(/Unsupported engine[\s\S]{0,200}?required: \{[^}]*node: '([^']+)'/) ?? text.match(/ERR_PNPM_UNSUPPORTED_ENGINE[\s\S]{0,200}?Expected version: ([^\n]+)/);
  if (engine) return `Node ${engine[1].trim()} is not installed`;
  const corepack = text.match(/This project is configured to use (\w+)(?: because [^\n]*)?/) ?? text.match(/Usage Error: This project's package\.json defines "packageManager": "(\w+)@/);
  if (corepack) return `${corepack[1]} is not installed`;
  if (/Please tell me who you are|Author identity unknown|unable to auto-detect email address/.test(text)) return "git has no user identity (user.name and user.email) on this machine";
  return null;
}

// The first error a compiler reports, rather than the build tool's tally ("2 Error(s)", "BUILD
// FAILURE"): C#'s "Orders.cs(5,80): error CS0103: ...", without MSBuild's trailing [project]; the
// first "[ERROR] /path/X.java:[l,c] ..." after Maven's "COMPILATION ERROR"; kotlinc's
// "e: file:///.../X.kt:l:c ...".
export function compilerError(output: string): string | null {
  const cs = output.match(/^\s*(\S[^\n]*?: error CS\d{4}: [^\n]*?)(?:\s+\[[^\]\n]+\])?\s*$/m);
  if (cs) return cs[1].trim();
  const maven = output.match(/COMPILATION ERROR[^\n]*\n(?:[^\n]*\n)*?\[ERROR\] (\S+\.(?:java|kt|groovy|scala):\[\d+,\d+\][^\n]*)/);
  if (maven) return maven[1].trim();
  const kotlin = output.match(/^e: ((?:file:\/\/)?\S+\.kts?:\d+:\d+ [^\n]+)$/m);
  if (kotlin) return kotlin[1].trim();
  return null;
}

// A remote-tracking ref or remote the audit's clean copy doesn't have: it is one commit with no
// remote, so "origin/v2/main", "upstream/main" and the like never resolve there.
const REF = String.raw`["'\`]?((?:origin|upstream)\/[\w.\/-]*[\w-]|[\w.-]+\/main|[\w.-]+\/master)["'\`]?`;
const MISSING_REF: RegExp[] = [
  new RegExp(String.raw`(?:cannot resolve|could not resolve|can't resolve|unable to resolve)\s+${REF}`, "i"),
  new RegExp(String.raw`${REF}\s+is not available`, "i"),
  new RegExp(String.raw`Failed to find where HEAD diverged from\s+${REF}`, "i"),
  new RegExp(String.raw`(?:fatal: )?(?:ambiguous argument|bad revision|unknown revision|Not a valid object name)\s+${REF}`, "i"),
  new RegExp(String.raw`fatal: '(origin|upstream)' does not appear to be a git repository|fatal: No such remote '?(origin|upstream)'?`, "i"),
];

export function missingRef(output: string): string | null {
  for (const re of MISSING_REF) {
    const m = output.match(re);
    if (m) return `the clean copy has no ${m.slice(1).find(Boolean) ?? "remote"} ref; it is one commit with no remote`;
  }
  return null;
}

// An interactive prompt: arrow-key pickers and y/N questions.
const PROMPT = /↑\/↓ to navigate|Use arrow keys|\(y\/N\)\s*$|\[y\/N\]\s*$/m;

// The tests a Go or Rust run names as failing: go test's "--- FAIL: TestX" (a subtest only when its
// parent isn't listed) and cargo test's "test name ... FAILED". Their last line is just "FAIL" or
// "error: test failed", which says nothing about which test.
// dotnet test's "  Failed Namespace.Class.Test [12 ms]" and Surefire's summary lines under
// "[ERROR] Failures:" or "[ERROR] Errors:" ("[ERROR]   CartTest.total:12 expected..."), whose tally
// says only how many.
export function failingTests(output: string): string[] {
  const go = [...output.matchAll(/^\s*--- FAIL: (\S+)/gm)].map((m) => m[1]);
  const top = go.filter((t) => !go.some((p) => t.startsWith(`${p}/`)));
  const rust = [...output.matchAll(/^test (\S+) \.\.\. FAILED\s*$/gm)].map((m) => m[1]);
  const dotnet = [...output.matchAll(/^\s*Failed ([\w.+`<>,]+(?:\([^)\n]*\))?) \[[^\]\n]+\]\s*$/gm)].map((m) => m[1]);
  const surefire = [...output.matchAll(/^\[ERROR\] (?:Failures|Errors): ?\n((?:\[ERROR\] {2,}\S[^\n]*\n?)+)/gm)].flatMap((m) => [...m[1].matchAll(/^\[ERROR\] {2,}([\w$.]+?)(?::\d+)?(?: |$)/gm)].map((x) => x[1]));
  return [...new Set([...top, ...rust, ...dotnet, ...surefire])];
}

// Maven's [WARNING] lines and the tab-indented lines under them. Offline, Maven warns that it can't
// fetch plugin descriptors it never needs ("Failed to read artifact descriptor ... from/to central
// (...): repo.maven.apache.org"), so a warning is no evidence of why the build failed.
function withoutMavenWarnings(text: string): string {
  return text.replace(/^\[WARNING\][^\n]*(?:\n\t[^\n]*)*\n?/gm, "");
}

// Cut at a word boundary, so a message never ends mid-URL.
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2)).replace(/[\s,;:]+$/, "")} …`;
}

// Lines PHPStan decorates with an emoji (its identifier and tip lines); the report never shows one.
const PICTOGRAPH = /\p{Extended_Pictographic}/u;

// The error a build tool reports as the cause, rather than its closing lines ("mvn <args> -rf
// :module", "BUILD FAILED in 4m 17s", "[ERROR] Found 1 error"): Maven's "Failed to execute goal"
// block, Gradle's "What went wrong", Composer's problem list and PHPStan's error table. Null when the
// output has none of them.
export function rootError(output: string): string | null {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  return mavenRoot(text) ?? gradleRoot(text) ?? composerRoot(text) ?? phpstanRoot(text);
}

const MAVEN_GENERIC = /^(Compilation failure|There are test failures\.?|There was an error in the forked process|)$/;
const MAVEN_BOILERPLATE = /^(-> \[Help \d+\]|To see the full stack trace|Re-run Maven using|For more information about the errors|\[Help \d+\]|After correcting the problems|mvn <args>|Please refer to )/;

function mavenRoot(text: string): string | null {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^\[ERROR\] Failed to execute goal /.test(l));
  if (at < 0) return null;
  const m = lines[at].match(/^\[ERROR\] Failed to execute goal (?:[\w.-]+:([\w.-]+):[\w.-]+:([\w-]+) \([^)]*\) )?on project ([\w.-]+):\s*(.*?)\s*(?:-> \[Help \d+\])?\s*$/);
  if (!m) return null;
  const [, artifact, goal, project, message] = m;
  const step = artifact && goal ? `${artifact.replace(/^maven-/, "").replace(/(-maven)?-plugin$/, "")}:${goal}` : "the build";
  const rest: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith("[ERROR]")) break;
    const body = l.replace(/^\[ERROR\]\s?/, "").trim();
    if (/^(-> \[Help \d+\]|To see the full stack trace)/.test(body)) break;
    if (body && !MAVEN_BOILERPLATE.test(body)) rest.push(body);
  }
  const compile = rest.find((l) => /\S+\.(java|kt|groovy|scala):\[\d+,\d+\]/.test(l));
  const thrown = rest.find((l) => /^(?:[a-z][\w$]*\.)+[A-Z][\w$]*(?:Error|Exception)\b/.test(l));
  const said = message.endsWith(":") ? `${message} ${rest[0] ?? ""}`.trim() : MAVEN_GENERIC.test(message) ? (compile ?? thrown ?? rest[0] ?? message) : message;
  return clip(`${step} failed in module ${project}: ${said || "no message"}`, 240);
}

function gradleRoot(text: string): string | null {
  const block = text.match(/^\* What went wrong:\n([\s\S]*?)(?=\n\* (?:Try|Where|Exception is):|\n\n|(?![\s\S]))/m)?.[1];
  if (!block) return null;
  const lines = block.split("\n").map((l) => l.trim()).filter((l) => l && !/^Required by:|^(project|root project) [:']/.test(l));
  const head = lines[0]?.replace(/^>\s*/, "");
  if (!head) return null;
  const deepest = [...lines].reverse().find((l) => l.startsWith(">"))?.replace(/^>\s*/, "");
  const first = (s: string) => s.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? s;
  const said = deepest && first(deepest) !== first(head) ? `${first(head).replace(/\.$/, "")}: ${first(deepest)}` : first(head);
  return clip(said, 240);
}

function composerRoot(text: string): string | null {
  const problems = [...text.matchAll(/^\s*Problem \d+\s*\n((?:\s+- [^\n]*\n?)+)/gm)];
  if (!problems.length) return null;
  const bullets = problems[0][1].split("\n").map((l) => l.trim().replace(/^- /, "")).filter(Boolean);
  const last = bullets[bullets.length - 1].replace(/ from composer repo \([^)]*\)/g, "").replace(/\s*See https?:\/\/\S+ for [^.]*\.?$/, "").trim();
  const more = problems.length > 1 ? ` (and ${problems.length - 1} more ${problems.length === 2 ? "problem" : "problems"})` : "";
  return `${clip(last, 260)}${more}`;
}

function phpstanRoot(text: string): string | null {
  const found = text.match(/\[ERROR\] Found (\d+) errors?/);
  if (!found) return null;
  const lines = text.split("\n");
  const sep = /^\s*-{2,}(\s+-{2,})+\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/^\s*(Line|Error)\s+(\S.*?)?\s*$/);
    if (!head || !sep.test(lines[i + 1] ?? "")) continue;
    const file = head[1] === "Line" ? head[2] : undefined;
    const parts: string[] = [];
    let line: string | undefined;
    for (let j = i + 2; j < lines.length && !sep.test(lines[j]); j++) {
      const row = lines[j].match(/^\s*(:?\d+)?\s{2,}(\S.*?)\s*$/) ?? lines[j].match(/^\s*()(\S.*?)\s*$/);
      if (!row || PICTOGRAPH.test(lines[j])) continue;
      if (row[1] && parts.length) break;
      if (row[1]) line = row[1].replace(/^:/, "");
      parts.push(row[2]);
    }
    if (!parts.length) continue;
    const n = Number(found[1]);
    const where = file ? ` in ${file}${line ? `:${line}` : ""}` : "";
    return clip(`${n === 1 ? `PHPStan found 1 error${where}` : `PHPStan found ${n} errors; the first${where}`}: ${parts.join(" ")}`, 260);
  }
  return null;
}

// What the audit appends to a timed-out command's output when the command's processes used no CPU
// in the seconds before it was stopped, and whether the network was off then.
export const IDLE_MARK = "readiness: idle at the timeout";
export const IDLE_OFFLINE = "with the network off";

// A .NET NativeAOT build links with the platform's C toolchain, which an SDK image may not ship:
// "Platform linker ('clang' or 'gcc') not found in PATH", the symbol-stripping tool, or zlib for -lz.
export function nativeAotGap(output: string): string | null {
  if (/Platform linker \('clang' or 'gcc'\) not found in PATH/.test(output)) return "clang or gcc, the native linker NativeAOT needs, is not installed";
  if (/Symbol stripping tool \('[\w-]+'(?: or '[\w-]+')?\) not found in PATH/.test(output)) return "objcopy, which NativeAOT strips symbols with, is not installed";
  if (/Microsoft\.NETCore\.Native\.Unix\.targets[^\n]*/.test(output) && /cannot find -lz\b/.test(output)) return "zlib1g-dev, which NativeAOT links against, is not installed";
  return null;
}

// A host on the internet that a failing test's own output names, such as pocketbase's OAuth2 test
// fetching https://pocketbase.io/images/logo.svg. Its app swallows the failed download, so no
// network error is printed. Hosts that never leave the machine, and reserved example and test
// domains, don't count.
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal|(.+\.)?(example\.(com|org|net)|test|invalid|local|localhost|internal))$/i;

// Documentation, source hosting and tooling sites that runners and assertion libraries link to in
// their own messages ("see https://jestjs.io/docs/...").
const DOC_HOST = /(^|\.)(github\.com|githubusercontent\.com|gitlab\.com|bitbucket\.org|npmjs\.(com|org)|nodejs\.org|jestjs\.io|vitest\.dev|mochajs\.org|go\.dev|golang\.org|rust-lang\.org|docs\.rs|crates\.io|python\.org|pypi\.org|readthedocs\.io|apache\.org|gradle\.org|junit\.org|microsoft\.com|aka\.ms|mozilla\.org|w3\.org|json-schema\.org|stackoverflow\.com|ruby-lang\.org|rubygems\.org|php\.net|getcomposer\.org)$/i;
const HELP_LINE = /\b(see|docs?|documentation|learn more|more info(rmation)?|read more|refer to|visit|help|issue)\b/i;

// Each failing Go test's own lines. With -v a test logs under its "=== RUN" line, above the
// package's FAIL line that failingPart keeps; without -v under its "--- FAIL" line, indented.
export function goFailingBlocks(output: string): string {
  const lines = output.split("\n");
  const failed = new Set([...output.matchAll(/^\s*--- FAIL: (\S+)/gm)].map((m) => m[1]));
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const run = lines[i].match(/^=== RUN\s+(\S+)\s*$/);
    const fail = lines[i].match(/^(\s*)--- FAIL: \S+/);
    if (!(run && failed.has(run[1])) && !fail) continue;
    const indent = fail ? fail[1].length : -1;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (/^\s*(=== (RUN|PAUSE|CONT|NAME)|--- (PASS|FAIL|SKIP))/.test(l)) break;
      if (fail && l.trim() && (l.match(/^\s*/)?.[0].length ?? 0) <= indent) break;
      out.push(l);
    }
  }
  return out.join("\n");
}

export function externalHost(output: string): string | null {
  for (const line of output.split("\n")) {
    if (HELP_LINE.test(line)) continue;
    for (const m of line.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?::\d+)?/gi)) {
      if (!LOCAL_HOST.test(m[1]) && !DOC_HOST.test(m[1])) return m[1].toLowerCase();
    }
  }
  return null;
}

export function diagnose(rawOutput: string, timedOut: boolean, phase: string): Diagnosis {
  const clean = withoutMavenWarnings(rawOutput.replace(/\x1b\[[0-9;]*m/g, ""));
  // Stuck with no CPU while the network was off: most likely waiting on a download, such as an
  // npm install of a packed tarball inside a test script.
  if (timedOut && rawOutput.includes(`${IDLE_MARK}`) && rawOutput.includes(IDLE_OFFLINE)) return { cause: "network", detail: `the ${phase} step stopped using CPU ${IDLE_OFFLINE}, likely waiting on the network` };
  if (timedOut) return { cause: "timeout", detail: `the ${phase} step ran out of time` };
  const focus = failingPart(clean);
  const output = `${focus}\n${unwrap(focus)}`;
  const gap = toolchainGap(output);
  if (gap) return { cause: "missing_tool", detail: gap };
  const permission = permissionLimit(output);
  if (permission) return { cause: "permission", detail: permission };
  const python = pythonMismatch(output);
  if (python) return { cause: "missing_tool", detail: python };
  if (PLAYWRIGHT.test(output)) return { cause: "missing_tool", detail: "Playwright's browsers are not installed" };
  const refused = output.match(/ECONNREFUSED (?:127\.0\.0\.1|::1|localhost|\[::1\]):(\d+)|connect(?:ion)? refused[^\n]*?:(\d{2,5})/i);
  if (refused) {
    const port = refused[1] ?? refused[2];
    const service = PORTS[port] ?? `a service on port ${port}`;
    if (PORTS[port] && NAMED[port]?.test(output)) return { cause: "service", detail: `connection refused on port ${port}; the output names ${service}`, service, serviceNamed: true };
    return { cause: "service", detail: `connection refused on port ${port}`, service };
  }
  const cred = output.match(/\bMissing (?:required )?(?:env(?:ironment)? (?:var(?:iable)?)?\s*)?([A-Z][A-Z0-9_]{2,})\b|\b([A-Z][A-Z0-9_]{2,}) (?:is )?(?:not set|required|missing)\b/);
  if (cred) {
    const name = cred[1] ?? cred[2];
    if (SECRET_NAME.test(name)) return { cause: "credential", detail: `needs ${name}` };
  }
  if ((phase === "install" || phase === "doctor") && (/\b(E?401|Unauthorized|authentication required|no auth token)\b/i.test(output) || /Failed to replace env in config: \$\{[A-Z_]+\}/.test(output))) {
    return { cause: "registry", detail: "registry credentials not provided" };
  }
  // A refused package download explains whatever is missing after it.
  const mirror = mirrorRefused(output);
  if (mirror) return { cause: "network", detail: mirror };
  if (/ensurepip is not\s+available|No module named venv\b/.test(output)) return { cause: "missing_tool", detail: "python3-venv is not installed" };
  const ref = missingRef(output);
  if (ref) return { cause: "missing_ref", detail: ref };
  if (PROMPT.test(output)) return { cause: "interactive", detail: "it stopped at a prompt that waits for a person's answer" };
  if (/\bENEEDAUTH\b|This command requires you to be logged in/.test(output)) return { cause: "credential", detail: "needs a logged-in npm account" };
  // A repo script's own words for a tool it can't find: "no usable `claude` CLI on PATH", "uv not
  // found on PATH". Not for a test run, whose output can log such a line on a path it falls back
  // from ("Node.js was not found on PATH; using the pure-Python extractor").
  const onPath = phase === "test" ? null : output.match(/\bno usable [`'"]?([\w.+-]+)[`'"]? CLI\b|(?:^|[\s(`'"])[`'"]?([A-Za-z][\w.+-]*)[`'"]? (?:CLI )?(?:was |is )?(?:not found|not installed|not available) on (?:your |the )?PATH\b/im);
  if (onPath) return { cause: "missing_tool", detail: `${onPath[1] ?? onPath[2]} is not installed` };
  const tool = output.match(/(?:^|\n)(?:[^\n:]*: line \d+: |[^\n:]*: \d+: |(?:ba)?sh: )?([\w.+-]+): (?:command )?not found/);
  if (tool) return { cause: "missing_tool", detail: `${tool[1]} is not installed` };
  // GNU make runs a simple recipe line itself, so a missing tool reads "make: golangci-lint: No such
  // file or directory" and then "Error 127". A path such as ./scripts/x.sh is the repo's own file.
  const makeTool = output.match(/(?:^|\n)make(?:\[\d+\])?: ([\w.+-]+): (?:No such file or directory|Command not found)\n(?:[^\n]*\n)*?[^\n]*\bError 127\b/);
  if (makeTool) return { cause: "missing_tool", detail: `${makeTool[1]} is not installed` };
  const aot = nativeAotGap(output);
  if (aot) return { cause: "missing_tool", detail: aot };
  const mod = MISSING_MODULE.map((re) => output.match(re)).filter((m): m is RegExpMatchArray => m !== null).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0];
  if (mod) return { cause: "missing_module", detail: `module ${mod[1]} is missing` };
  const network = networkFailure(output);
  if (network) return { cause: "network", detail: phase === "test" ? "a test tried to reach the network, which is off while tests run" : network };
  if (/SyntaxError|error TS\d{4}|IndentationError/.test(output)) return { cause: "compile", detail: "the code doesn't compile" };
  const compiler = compilerError(clean);
  if (compiler) return { cause: "compile", detail: compiler.slice(0, 200) };
  const named = failingTests(clean);
  // Go's -v output keeps later packages' passing logs after the first FAIL line, so a Go run is
  // read only from its failing tests' own lines.
  const goBlocks = phase === "test" ? goFailingBlocks(clean) : "";
  const host = phase === "test" ? externalHost(goBlocks.trim() ? goBlocks : focus) : null;
  if (host) return { cause: "network", detail: `${named.length ? `${named[0]} failed; it` : "a failing test"} refers to ${host}, and tests run with the network off` };
  if (named.length) return { cause: "unknown", detail: named.length === 1 ? `${named[0]} failed` : `${named[0]} and ${named.length - 1} more failed` };
  const root = rootError(clean);
  if (root) return { cause: "unknown", detail: root, fromTool: true };
  // Ruby's uncaught error: "/path/x.rb:12:in 'Method': message (Class)", above its "from" frames.
  const ruby = clean.match(/^\S+\.rb:\d+:in '[^'\n]+': ([^\n]+?) \(((?:[A-Z]\w*::)*[A-Z]\w*)\)\s*$/m);
  if (ruby) return { cause: "unknown", detail: clip(`${ruby[1]} (${ruby[2]})`, 200), fromTool: true };
  const lines = (focus.trim() ? focus : clean).split("\n").map((l) => l.trim()).filter(Boolean);
  // node --test's TAP block lists code, failureType and the like after the error itself; Ruby lists
  // its backtrace as "from /path/x.rb:12:in ...".
  const noise = /^(npm (error|ERR!|warn)|ELIFECYCLE|error Command failed|>\s|\$ |command failed|at |from \S+:\d+:in |# |(code|failureType|type|location|duration_ms|stack): )/i;
  const meaningful = lines.filter((l) => !noise.test(l));
  const errLine = [...meaningful].reverse().find((l) => /error|fail|assert|exception|remove|missing|expected/i.test(l)) ?? meaningful[meaningful.length - 1] ?? lines[lines.length - 1] ?? "no output";
  return { cause: "unknown", detail: errLine.replace(/^error: '(.*)'$/, "$1").slice(0, 160) };
}
