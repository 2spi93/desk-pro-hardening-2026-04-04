import { NextResponse } from 'next/server';

import { getControlPlaneNetworkMetricsSnapshot } from '../../../../lib/controlPlane';
import { getMetricsSnapshot } from '../../../../lib/shadowMode';

/**
 * GET /api/system/shadow-metrics
 * 
 * Returns current shadow mode metrics for observability and dashboarding
 * Used by ops/SRE to track fallback rates, divergence, and backend stability
 * 
 * Response includes:
 * - Total calls per metric type
 * - Fallback rate (% of requests using fallback)
 * - Per-route breakdown
 * - Timestamp
 */
export async function GET() {
  const snapshot = getMetricsSnapshot();
  const controlPlaneNetwork = getControlPlaneNetworkMetricsSnapshot();

  return NextResponse.json(
    {
      status: 'ok',
      fallback_rate_pct: (snapshot.fallback_rate * 100).toFixed(2),
      metrics_snapshot: snapshot.metrics,
      control_plane_network: controlPlaneNetwork,
      control_plane_network_pct: {
        dns_transient_rate: (controlPlaneNetwork.dns_transient_rate * 100).toFixed(2),
        timeout_rate: (controlPlaneNetwork.timeout_rate * 100).toFixed(2),
        degraded_usage_ratio: (controlPlaneNetwork.degraded_usage_ratio * 100).toFixed(2),
        retry_recovered_ratio: (controlPlaneNetwork.retry_recovered_ratio * 100).toFixed(2),
      },
      timestamp: snapshot.timestamp,
      endpoints: {
        'auth/preferences': {
          note: 'Main UI preferences endpoint. Phase 1: shadow mode enabled, 0% rollout.'
        },
        'mt5/orders/risk-history': {
          note: 'Trade execution quality metrics. Phase 1: shadow mode enabled, 0% rollout.'
        },
        'mt5/orders/risk-history/summary': {
          note: 'Risk KPI aggregates. Phase 1: shadow mode enabled, 0% rollout.'
        }
      },
      phases: {
        current: 'Phase 1: Shadow Mode Testing',
        next: 'Phase 2: Gradual Rollout (10% → 50% → 100%)',
        success_criteria: {
          shadow_diff_pct: '< 2%',
          fallback_rate_pct: '0% (UI stable on fallback)',
          backend_p99_latency_ms: '< 500ms',
          dns_transient_rate_pct: '< 5%',
          degraded_usage_ratio_pct: '< 1%'
        }
      }
    },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Metrics-Freshness': 'real-time'
      }
    }
  );
}
