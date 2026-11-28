// The test-file rule Node and Python share. It reads only the path, so it also matches any file
// under a test/ or tests/ folder, whatever its language: `readiness diff` counts those as tests too.
const TEST_FILE = /(\.test\.|\.spec\.|(^|\/)tests?\/|(^|\/)__tests__\/|(^|\/)tests?\.(m?[jt]sx?|cjs|py)$|(^|\/)test_[^/]*\.py$|_test\.py$)/;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}
