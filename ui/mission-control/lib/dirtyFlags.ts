export type DirtyState = {
  candle: boolean;
  indicator: boolean;
  overlay: boolean;
};

export function createDirtyState(): DirtyState {
  return {
    candle: false,
    indicator: false,
    overlay: false,
  };
}

export function resetDirtyState(state: DirtyState): void {
  state.candle = false;
  state.indicator = false;
  state.overlay = false;
}
