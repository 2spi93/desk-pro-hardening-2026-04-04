/**
 * Shadow Mode Backend Integration
 * 
 * Safely tests real backend endpoints while keeping UI on fallbacks.
 * Enables gradual migration: shadow → dual → real
 * 
 * Features:
 * - Parallel backend calls (non-blocking)
 * - Divergence detection (real vs fallback)
 * - Structured logging for observability
 * - Feature flags for gradual rollout
 * - Automatic metrics collection
 */

import { NextResponse } from 'next/server';

export interface ShadowConfig {
  route: string;
  enabled: boolean;
  shadowOnly: boolean; // test backend, return fallback
  dualMode: boolean;   // use backend if successful, else fallback
  rolloutPercentage: number; // % of users getting real backend (0-100)
  userId?: string;
}

export interface ShadowResult<T> {
  backend: {
    status: 'ok' | 'fail' | 'timeout';
    data?: T;
    error?: string;
    latency_ms: number;
    timestamp: string;
  };
  fallback: {
    data: T;
    timestamp: string;
  };
  divergence: {
    detected: boolean;
    reason?: string;
  };
  shouldUseFallback: boolean; // final decision
}

export interface MetricEvent {
  type: 'fallback' | 'shadow_ok' | 'shadow_fail' | 'shadow_diff' | 'dual_success' | 'dual_fallback';
  route: string;
  latency_ms?: number;
  reason?: string;
  timestamp: string;
}

// Global metrics accumulator
const metrics = new Map<string, number>();

function isTruthyEnvFlag(name: string): boolean {
  const raw = String(process.env[name] || '').toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function isShadowNoiseSuppressed(): boolean {
  if (String(process.env.MC_SHADOW_SILENT || '').trim()) {
    return isTruthyEnvFlag('MC_SHADOW_SILENT');
  }
  if (String(process.env.MC_E2E_DEV_DEGRADED_SILENT || '').trim()) {
    return isTruthyEnvFlag('MC_E2E_DEV_DEGRADED_SILENT');
  }
  return isTruthyEnvFlag('PLAYWRIGHT_TEST');
}

function recordMetric(event: MetricEvent) {
  const key = `${event.type}_${event.route}`;
  metrics.set(key, (metrics.get(key) || 0) + 1);

  if (isShadowNoiseSuppressed()) {
    return;
  }

  // Structured log for observability
  console.warn('[TXT][SHADOW_METRIC]', {
    event: event.type,
    route: event.route,
    latency_ms: event.latency_ms,
    reason: event.reason,
    timestamp: event.timestamp,
  });
}

export function getFallbackRate(): number {
  const total = Array.from(metrics.values()).reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  
  const fallbackCount = (metrics.get('fallback_*') || 0) + 
                        Array.from(metrics.keys())
                          .filter(k => k.includes('fallback'))
                          .reduce((sum, k) => sum + (metrics.get(k) || 0), 0);
  
  return fallbackCount / total;
}

export function getMetricsSnapshot() {
  return {
    metrics: Object.fromEntries(metrics),
    fallback_rate: getFallbackRate(),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Determine if user should get real backend based on rollout %
 */
function shouldRolloutToUser(userId: string | undefined, rolloutPercentage: number): boolean {
  if (rolloutPercentage === 0) return false;
  if (rolloutPercentage === 100) return true;
  
  // Deterministic: same user always gets same treatment
  if (!userId) {
    // No user context: use random
    return Math.random() * 100 < rolloutPercentage;
  }
  
  // Hash-based: consistent per user
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash) + userId.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  
  return (Math.abs(hash) % 100) < rolloutPercentage;
}

/**
 * Deep comparison for divergence detection
 */
function compareObjects(a: any, b: any, path = ''): { equal: boolean; reasons: string[] } {
  const reasons: string[] = [];
  
  if (typeof a !== typeof b) {
    reasons.push(`Type mismatch at ${path}: ${typeof a} vs ${typeof b}`);
    return { equal: false, reasons };
  }
  
  if (a === null || b === null) {
    if (a !== b) {
      reasons.push(`Null mismatch at ${path}`);
      return { equal: false, reasons };
    }
    return { equal: true, reasons };
  }
  
  if (typeof a !== 'object') {
    // Tolerate small numeric differences (< 1%)
    if (typeof a === 'number' && typeof b === 'number') {
      const diff = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1);
      if (diff > 0.01) {
        reasons.push(`Numeric diff at ${path}: ${a} vs ${b} (${(diff * 100).toFixed(1)}%)`);
        return { equal: false, reasons };
      }
      return { equal: true, reasons };
    }
    
    if (a !== b) {
      reasons.push(`Value mismatch at ${path}: ${a} vs ${b}`);
      return { equal: false, reasons };
    }
    return { equal: true, reasons };
  }
  
  if (Array.isArray(a) !== Array.isArray(b)) {
    reasons.push(`Array mismatch at ${path}`);
    return { equal: false, reasons };
  }
  
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  
  if (aKeys.length !== bKeys.length) {
    const missing = aKeys.filter(k => !bKeys.includes(k));
    const extra = bKeys.filter(k => !aKeys.includes(k));
    if (missing.length > 0) reasons.push(`Missing keys in real: ${missing.join(',')}`);
    if (extra.length > 0) reasons.push(`Extra keys in real: ${extra.join(',')}`);
  }
  
  for (const key of aKeys) {
    if (!bKeys.includes(key)) {
      reasons.push(`Missing key in real at ${path}.${key}`);
      return { equal: false, reasons };
    }
    
    const nested = compareObjects(a[key], b[key], `${path}.${key}`);
    if (!nested.equal) {
      reasons.push(...nested.reasons);
      return { equal: false, reasons };
    }
  }
  
  return { equal: true, reasons };
}

/**
 * Main shadow mode orchestrator
 */
export async function executeWithShadowMode<T>(config: ShadowConfig, {
  fetchBackend,
  getFallback,
  normalizeForComparison,
}: {
  fetchBackend: () => Promise<T>;
  getFallback: () => T;
  normalizeForComparison?: (data: T, source: 'backend' | 'fallback') => unknown;
}): Promise<ShadowResult<T>> {
  const startTime = Date.now();
  const fallback = getFallback();
  
  if (!config.enabled) {
    // Shadow mode disabled: straight fallback
    recordMetric({
      type: 'fallback',
      route: config.route,
      reason: 'shadow_disabled',
      timestamp: new Date().toISOString(),
    });
    
    return {
      backend: {
        status: 'fail',
        latency_ms: 0,
        timestamp: new Date().toISOString(),
      },
      fallback: {
        data: fallback,
        timestamp: new Date().toISOString(),
      },
      divergence: { detected: false },
      shouldUseFallback: true,
    };
  }
  
  // Determine rollout eligibility
  const userEligible = shouldRolloutToUser(config.userId, config.rolloutPercentage);
  
  // Fetch backend in parallel (non-blocking)
  let backendResult: { status: 'ok' | 'fail' | 'timeout'; data?: T; error?: string } = {
    status: 'fail',
  };
  let backendLatency = 0;
  
  try {
    const backendPromise = fetchBackend();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 3000)
    );
    
    const start = Date.now();
    const data = await Promise.race([backendPromise, timeoutPromise]) as T;
    backendLatency = Date.now() - start;
    
    backendResult = { status: 'ok', data };
    
    recordMetric({
      type: 'shadow_ok',
      route: config.route,
      latency_ms: backendLatency,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    backendLatency = Date.now() - startTime;
    backendResult = {
      status: (error as any)?.message === 'timeout' ? 'timeout' : 'fail',
      error: String(error),
    };
    
    recordMetric({
      type: 'shadow_fail',
      route: config.route,
      latency_ms: backendLatency,
      reason: backendResult.status,
      timestamp: new Date().toISOString(),
    });
  }
  
  // Divergence check
  let divergenceDetected = false;
  let divergenceReason = '';
  
  if (backendResult.status === 'ok' && backendResult.data) {
    const comparison = compareObjects(
      normalizeForComparison ? normalizeForComparison(backendResult.data, 'backend') : backendResult.data,
      normalizeForComparison ? normalizeForComparison(fallback, 'fallback') : fallback,
    );
    if (!comparison.equal) {
      divergenceDetected = true;
      divergenceReason = comparison.reasons.slice(0, 3).join(' | '); // First 3 reasons
      
      recordMetric({
        type: 'shadow_diff',
        route: config.route,
        reason: divergenceReason,
        timestamp: new Date().toISOString(),
      });

      if (!isShadowNoiseSuppressed()) {
        console.warn('[TXT][SHADOW_DIFF]', {
          route: config.route,
          divergence: divergenceReason,
          backend_latency_ms: backendLatency,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }
  
  // Decision: use fallback or real data?
  let shouldUseFallback = true;
  
  if (config.shadowOnly) {
    // Shadow only: always return fallback, backend is test-only
    shouldUseFallback = true;
  } else if (config.dualMode && backendResult.status === 'ok' && userEligible) {
    // Dual mode: use backend if successful and user is in rollout
    shouldUseFallback = false;
    recordMetric({
      type: 'dual_success',
      route: config.route,
      latency_ms: backendLatency,
      timestamp: new Date().toISOString(),
    });
  } else if (!config.shadowOnly && !config.dualMode && backendResult.status === 'ok' && userEligible) {
    // Full mode: use backend (no fallback)
    shouldUseFallback = false;
  } else if (backendResult.status === 'fail') {
    // Backend failed: use fallback
    shouldUseFallback = true;
    recordMetric({
      type: 'dual_fallback',
      route: config.route,
      reason: backendResult.error,
      timestamp: new Date().toISOString(),
    });
  }
  
  return {
    backend: {
      status: backendResult.status,
      data: backendResult.data,
      error: backendResult.error,
      latency_ms: backendLatency,
      timestamp: new Date().toISOString(),
    },
    fallback: {
      data: fallback,
      timestamp: new Date().toISOString(),
    },
    divergence: {
      detected: divergenceDetected,
      reason: divergenceReason,
    },
    shouldUseFallback,
  };
}

/**
 * Helper: Return appropriate response based on shadow result
 */
export function shadowResponse<T>(result: ShadowResult<T>, statusCode = 200) {
  const data = result.shouldUseFallback ? result.fallback.data : result.backend.data;
  
  const headers: Record<string, string> = {};
  if (result.backend.status === 'ok' && !result.shouldUseFallback) {
    headers['X-Data-Source'] = 'backend';
  } else {
    headers['X-Data-Source'] = 'fallback';
  }
  
  return NextResponse.json(data, {
    status: statusCode,
    headers,
  });
}
