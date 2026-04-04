export type InteractionState = {
  velocity: number;
  position: number;
  lastDelta: number;
};

/** "linear" = proportional response. "sqrt" = softer feel: small inputs amplified, large inputs dampened. */
export type InteractionCurve = "linear" | "sqrt";

type InteractionOptions = {
  friction?: number;
  sensitivity?: number;
  epsilon?: number;
  /** Input-response curve. Default "linear". Use "sqrt" for TradingView-like feel. */
  curve?: InteractionCurve;
  /** Soft velocity cap via tanh. 0 = no cap. */
  maxVelocity?: number;
};

const DEFAULT_FRICTION = 0.92;
const DEFAULT_SENSITIVITY = 0.002;
const DEFAULT_EPSILON = 0.0001;

export function createInteractionEngine(options?: InteractionOptions) {
  const friction = options?.friction ?? DEFAULT_FRICTION;
  const sensitivity = options?.sensitivity ?? DEFAULT_SENSITIVITY;
  const epsilon = options?.epsilon ?? DEFAULT_EPSILON;
  const curve: InteractionCurve = options?.curve ?? "linear";
  const maxVelocity = options?.maxVelocity ?? 0;

  const state: InteractionState = {
    velocity: 0,
    position: 0,
    lastDelta: 0,
  };

  function onWheel(delta: number): void {
    const raw = delta * sensitivity;
    // sqrt curve: preserves direction, compresses large impulses → feels like TradingView
    const impulse =
      curve === "sqrt"
        ? Math.sign(raw) * Math.sqrt(Math.abs(raw))
        : raw;
    state.velocity += impulse;
    // Soft velocity cap: tanh smoothly limits without hard clipping
    if (maxVelocity > 0) {
      state.velocity = Math.tanh(state.velocity / maxVelocity) * maxVelocity;
    }
  }

  function update(): { position: number; velocity: number; delta: number } {
    const prev = state.position;
    state.velocity *= friction;
    state.position += state.velocity;
    state.lastDelta = state.position - prev;

    if (Math.abs(state.velocity) < epsilon) {
      state.velocity = 0;
    }

    return {
      position: state.position,
      velocity: state.velocity,
      delta: state.lastDelta,
    };
  }

  function reset(): void {
    state.velocity = 0;
    state.position = 0;
    state.lastDelta = 0;
  }

  function getState(): InteractionState {
    return { ...state };
  }

  return { onWheel, update, reset, getState };
}

