export interface SelectionOptions {
  automated: boolean;
  requestedIds: string[];
  supportedIds: string[];
}

export interface SelectionResult {
  selectedIds: string[];
  valid: boolean;
}

export function validateSelection(options: SelectionOptions): SelectionResult {
  const { requestedIds, supportedIds } = options;

  if (requestedIds.length === 0) {
    return { selectedIds: [], valid: false };
  }

  const unique = new Set(requestedIds);
  if (unique.size !== requestedIds.length) {
    return { selectedIds: [], valid: false };
  }

  for (const id of requestedIds) {
    if (!supportedIds.includes(id)) {
      return { selectedIds: [], valid: false };
    }
  }

  return { selectedIds: [...requestedIds], valid: true };
}

export function isScenarioSelected(scenarioId: string, selectedIds: string[], automated: boolean): boolean {
  if (selectedIds.length === 0) return !automated;
  return selectedIds.includes(scenarioId);
}
