// The whole skill is a preview until 1.0. This is the only source of the Preview label: the report
// (report.json, report.md, report.html), the CLI's help, version and seal output, and the notes in
// README.md, SKILL.md and references/ all carry exactly this text. At 1.0, set it to null and delete
// those notes; tests/preview.test.ts then fails on any copy left behind.
export const PREVIEW: string | null = "Preview: agent-readiness 0.2 is pre-1.0; results and scoring may change.";
