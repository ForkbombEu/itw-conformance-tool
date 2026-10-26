const REQUIREMENT_ID_PATTERNS = [/^\[([A-Z]+[-_]\d+\w*)\]\s*:/, /^([A-Z]+[-_]\d+\w*)\s*:/];

export function extractRequirementId(title: string): null | string {
  for (const pattern of REQUIREMENT_ID_PATTERNS) {
    const match = pattern.exec(title);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

export function extractDescription(title: string): string {
  for (const pattern of REQUIREMENT_ID_PATTERNS) {
    const replaced = title.replace(pattern, '').trim();
    if (replaced !== title) {
      return replaced;
    }
  }
  return title.trim();
}
