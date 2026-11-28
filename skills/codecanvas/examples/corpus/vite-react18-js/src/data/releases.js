export const METRICS = [
  { id: 'active-trains', label: 'Active trains', value: '4', delta: '+1 this cycle', tone: 'accent' },
  { id: 'pass-rate', label: 'Verification pass rate', value: '98.4%', delta: '+0.6% vs last week', tone: 'success' },
  { id: 'open-blockers', label: 'Open blockers', value: '2', delta: '1 critical review', tone: 'warning' },
];

export const RELEASES = [
  {
    id: 'rel-241',
    version: 'v2.4.1',
    title: 'Checkout Tax Breakdown',
    owner: 'Maya Lin',
    channel: 'web-prod',
    status: 'ready',
    screensTouched: 6,
    summary: 'Clarifies regional VAT line items and aligns summary spacing across breakpoints.',
    checks: [
      { id: 'chk-1', label: 'Visual diff under 0.1% threshold', done: true },
      { id: 'chk-2', label: 'Keyboard focus order verified', done: true },
      { id: 'chk-3', label: 'Staging smoke routes returning 200', done: true },
    ],
  },
  {
    id: 'rel-242',
    version: 'v2.4.2',
    title: 'Billing Seat Estimator',
    owner: 'Devon Patel',
    channel: 'web-beta',
    status: 'review',
    screensTouched: 11,
    summary: 'Introduces tiered seat breakdown cards with responsive grid stacking.',
    checks: [
      { id: 'chk-4', label: 'Token contrast ratio >= 4.5:1', done: true },
      { id: 'chk-5', label: 'Design sign-off on tablet layout', done: false },
      { id: 'chk-6', label: 'Telemetry payload schema check', done: true },
    ],
  },
  {
    id: 'rel-243',
    version: 'v2.4.3',
    title: 'Workspace Role Matrix',
    owner: 'Elena Gomez',
    channel: 'web-canary',
    status: 'blocked',
    screensTouched: 9,
    summary: 'Refines role permission badges and adds read-only audit drawer states.',
    checks: [
      { id: 'chk-7', label: 'Audit drawer scroll trap resolved', done: false },
      { id: 'chk-8', label: 'Empty state copy approved', done: true },
      { id: 'chk-9', label: 'Permissions API fixture recorded', done: false },
    ],
  },
];

export function findReleaseById(id) {
  return RELEASES.find((item) => item.id === id) || RELEASES[0];
}
