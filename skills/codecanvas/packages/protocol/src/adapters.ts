/**
 * Wire form: "packages/ui/src/Button.tsx:12:4@3f9c2a1b7d0e"
 * Defined by architecture-v2 §4.2 (implemented end-to-end in WP0.3).
 */
export interface SourceRef {
  file: string;
  line: number;
  col: number;
  rev: string;
  origin: 'jsx' | 'stack';
}

export interface Range {
  start: number;
  end: number;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

export interface Diagnostic {
  file: string;
  message: string;
  severity: 'error' | 'warning';
  /** 1-based line number when known. */
  line?: number;
  /** 1-based column number (alias of `column` for adapter compatibility). */
  col?: number;
  /** 1-based column number when known. */
  column?: number;
  code?: string;
  source?: string;
}

export interface FileChange {
  file: string;
  edits: TextEdit[];
}

export interface WorkspaceInfo {
  root: string;
  packageManager?: 'pnpm' | 'yarn' | 'npm' | 'bun';
}

export interface AppInfo {
  name: string;
  root: string;
  devScript?: string;
}

export interface ProjectProfile {
  workspace: WorkspaceInfo;
  apps: AppInfo[];
}

export interface Detection {
  adapterId: string;
  confidence: number;
  evidence: string[];
}

export interface LaunchProbe {
  ready: boolean;
  blockers: string[];
}

export interface LaunchRecipe {
  pre?: string[];
  command: string;
  env?: Record<string, string>;
  ready?: string;
}

export interface LaunchContext {
  daemonUrl: string;
  token: string;
  cacheDir: string;
}

export interface AppHost {
  url: string;
  pid: number;
  stop(): Promise<void>;
}

export interface SourcemapResolver {
  invalidate(buildId?: string): void;
  resolve(file: string, line: number, col: number): SourceRef | null;
}

/**
 * Adapter seams from architecture-v2 §5 (Invariant I9).
 * Core packages import only @codecanvas/protocol; adapters implement these
 * serializable interfaces in-process in v2.
 */
export interface FrameworkAdapter {
  readonly id: string;
  detect(ws: WorkspaceInfo): Detection | null;
  probeLaunch(app: AppInfo): Promise<LaunchProbe>;
  launch(recipe: LaunchRecipe, ctx: LaunchContext): Promise<AppHost>;
  routeEntries(route: string): string[];
  globalInputs(app: AppInfo): string[];
  readonly sourcemaps: SourcemapResolver;
}

export interface LanguageAdapter {
  readonly id: string;
  resolveRef(ref: SourceRef, expect?: { tag: string; text?: string }): unknown;
  describeNode(ref: SourceRef, owners?: readonly SourceRef[]): unknown;
  computeEdit(intent: unknown): unknown;
  insertionSlots(parent: SourceRef): unknown[];
  importGraph(file: string): unknown[];
  classifyModule(file: string): string;
  validate(file: string, text: string): Diagnostic[];
  indexComponents(roots: readonly string[]): unknown[];
}

export interface StyleAdapter {
  readonly id: string;
  detect(profile: ProjectProfile): Detection | null;
  attribute(decl: unknown, node: unknown): unknown | null;
  tokens?(): unknown[];
  plan(change: unknown, origins: readonly unknown[], scope: string): unknown[];
  write(plan: unknown): FileChange[];
}

export interface FlowSource {
  readonly id: string;
  discover(): Promise<unknown[]>;
  edges(flowRef: string): Promise<unknown[]>;
  connect?(from: SourceRef, toScreenRef: string, trigger: string): unknown;
  insertBetween?(aScreenRef: string, bScreenRef: string, name: string): unknown;
}

export interface StateInjector {
  readonly id: string;
  readonly modules: readonly string[];
  capture(): unknown;
  restore(snapshot: unknown): void;
}

export interface DataSource {
  readonly id: string;
  key(call: unknown): string;
  serve(call: unknown, rule: unknown, ctx: unknown): Promise<unknown>;
}

export interface AgentRunner {
  readonly id: string;
  run(task: unknown, clone: unknown): AsyncIterable<unknown>;
}
