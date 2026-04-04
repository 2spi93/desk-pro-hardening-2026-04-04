# Chart Perceptual Spec: Phases 1-3

## Scope

This specification defines the first three implementation phases for the mission-control terminal chart perceptual upgrade.

Goals:

- instrument the chart so perceptual instability is measurable
- enforce an explicit spacing policy instead of relying on implicit default chart compression
- stabilize autoscale behavior with hysteresis so the camera stops pumping on small range changes

Primary implementation files:

- `app/terminal/InstitutionalChart.tsx`
- `app/terminal/page.tsx`
- `app/globals.css`
- `app/terminal/chartPerceptual.ts`
- `app/terminal/ChartPerceptualDebugPanel.tsx`

## Phase 1: Perceptual Instrumentation

### Purpose

Expose the difference between market truth and perceived chart quality.

### Metrics

The chart must emit a perceptual telemetry payload with:

- symbol
- timeframe
- render mode
- density level
- motion preset
- viewport width
- visible bars count
- observed candle step in pixels
- target spacing policy
- autoscale source range and applied range
- top/bottom padding
- hysteresis transition mode (`init`, `hold`, `soft`, `hard`)
- total reframes, soft reframes, hard reframes
- latest price drift in pixels
- peak price drift in pixels
- render perf (`fps`, `frameTimeMs`, `cpuLoad`, `workerLatencyMs`)

### Emission rules

- telemetry must be updated periodically without causing render thrash
- raw refs may update every frame, but UI publication should be throttled
- debug telemetry must remain best-effort and must not block chart rendering

### Debug surface

A dedicated debug panel in the terminal must show:

- spacing target vs observed spacing
- body width and gap budget
- visible bars vs target visible bars
- autoscale raw range vs applied range
- hysteresis state
- reframe counts
- shift percentage and price drift
- render perf summary

## Phase 2: Spacing Policy

### Purpose

Make candle breathing explicit and deterministic by context.

### Profiles

The spacing policy must infer one of these profiles:

- `scalping`
- `intraday`
- `swing`
- `line`
- `footprint`

### Inputs

- chart mode
- timeframe
- lite/full interaction mode
- viewport width
- resolved motion preset

### Outputs

- `rightOffset`
- `barSpacing`
- `minBarSpacing`
- `preferredBodyWidthPx`
- `minGapPx`
- `targetVisibleBars`

### Rules

- low timeframe candle modes must keep more horizontal breathing
- swing views may show more context but cannot collapse to unreadable bodies
- the policy must be width-aware, not only timeframe-aware
- resize may update spacing policy, but user-driven zoom should not be force-reset once the user has taken control

### Success criteria

- candle bodies remain readable after initial load and resize
- the chart no longer collapses into arbitrarily thin candles on narrow but valid layouts
- initial visible range and self-heal range use the explicit policy target, not unrelated defaults

## Phase 3: Autoscale Hysteresis

### Purpose

Prevent micro-range changes from producing visible y-axis pumping.

### Strategy

The autoscale pipeline must:

- compute a candidate padded range from raw min/max
- preserve asymmetric headroom (`top > bottom`)
- hold the previous applied range while the raw range stays inside a comfort zone
- use a soft transition when leaving the comfort zone slightly
- use a hard transition only when the overflow becomes meaningful

### Transition modes

- `init`: first valid range
- `hold`: previous range preserved
- `soft`: interpolated transition toward new range
- `hard`: immediate switch to the new range

### Metrics

Track:

- current applied min/max
- current raw min/max
- top padding
- bottom padding
- last shift percentage
- total reframes
- soft reframes
- hard reframes

### Success criteria

- small oscillations inside the comfort zone no longer reframe the chart
- shrink-only ranges do not cause constant camera breathing
- only meaningful range breaks trigger a visible camera move

## Delivery checkpoints

1. chart emits perceptual telemetry
2. terminal exposes a dedicated perceptual debug panel
3. time scale policy is width-aware and timeframe-aware
4. autoscale uses hysteresis and reports transition modes
5. targeted chart lint and e2e remain green