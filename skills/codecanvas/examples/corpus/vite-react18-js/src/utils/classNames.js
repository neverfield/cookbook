/**
 * Joins truthy class names deterministically for computed className tests.
 */
export function joinClasses(...parts) {
  const result = [];
  for (const part of parts) {
    if (!part) continue;
    if (typeof part === 'string') {
      result.push(part);
    } else if (Array.isArray(part)) {
      const nested = joinClasses(...part);
      if (nested) result.push(nested);
    } else if (typeof part === 'object') {
      for (const [key, enabled] of Object.entries(part)) {
        if (enabled) result.push(key);
      }
    }
  }
  return result.join(' ');
}

export const RELEASE_STATUS_META = {
  ready: { label: 'Ready to ship', tone: 'success' },
  review: { label: 'In review', tone: 'warning' },
  blocked: { label: 'Blocked', tone: 'danger' },
};
