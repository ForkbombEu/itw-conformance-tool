export interface RegisterSelectedScenarioOptions {
  automated: boolean;
  selected: boolean;
}

export function registerSelectedScenario(
  options: RegisterSelectedScenarioOptions,
  register: () => void,
  registerSkipped: () => void
): void {
  if (options.selected) {
    register();
    return;
  }
  if (!options.automated) {
    registerSkipped();
  }
  // selected=false, automated=true: invoke neither
}
