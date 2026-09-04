import { useEffect, useState, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer
} from 'recharts';
import {
  ShieldCheck, AlertCircle,
  TrendingUp, RefreshCw, Activity, Target
} from 'lucide-react';
import api from '../api';

const fmt = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;
const fmtCr = (v: number) => `₹${(v / 10_000_000).toFixed(2)} Cr`;
const fmtPct = (v: number) => `${Number(v).toFixed(1)}%`;


function StatCard({ label, value, sublabel, color, icon: Icon }: {
  label: string; value: string; sublabel?: string; color: string; icon: React.ElementType;
}) {
  return (
    <div className="glass-panel stat-card" style={{ borderTop: `3px solid ${color}` }}>
      <div className="flex justify-between items-start">
        <span className="text-xs text-muted">{label}</span>
        <Icon size={16} color={color} />
      </div>
      <span className="text-h1 currency" style={{ marginTop: 8 }}>{value}</span>
      {sublabel && <span className="text-xs text-muted">{sublabel}</span>}
    </div>
  );
}

export default function Dashboard() {
  const [overview, setOverview] = useState<any>(null);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [byType, setByType] = useState<any[]>([]);
  const [agentVsBaseline, setAgentVsBaseline] = useState<any>(null);
  const [funnel, setFunnel] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dashRes, timeRes, baselineRes, funnelRes] = await Promise.all([
        api.get('/dashboard/overview'),
        api.get('/analytics/timeline'),
        api.get('/analytics/agent-vs-baseline'),
        api.get('/analytics/funnel'),
      ]);
      setOverview(dashRes.data.overview);
      setByType(dashRes.data.by_type || []);
      setTimeline(timeRes.data);
      setAgentVsBaseline(baselineRes.data);
      setFunnel(funnelRes.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading || !overview) {
    return (
      <div className="flex justify-center items-center" style={{ height: '60vh' }}>
        <div className="flex-col items-center gap-3">
          <RefreshCw size={28} className="animate-spin" style={{ color: 'var(--accent-primary)' }} />
          <p className="text-muted text-sm">Loading dashboard data...</p>
        </div>
      </div>
    );
  }

  const funnelData = funnel ? [
    { name: 'Revenue at Risk', value: Math.round(funnel.total_detected || 0), fill: '#ef4444' },
    { name: 'Assessed', value: Math.round(funnel.assessed || 0), fill: '#f59e0b' },
    { name: 'Agent Processed', value: Math.round(funnel.processed || 0), fill: '#3b82f6' },
    { name: 'Executed', value: Math.round(funnel.attempted || 0), fill: '#8b5cf6' },
    { name: 'Recovered', value: Math.round(funnel.recovered || 0), fill: '#10b981' },
  ] : [];

  return (
    <div className="flex-col gap-6 animate-fade-in">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-h1" style={{ letterSpacing: '-0.03em' }}>
            Revenue Recovery Console
          </h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)', marginTop: 4 }}>
            All figures computed from live database. Dataset seeded with deterministic seed 42.
          </p>
        </div>
        <button className="btn btn-secondary" onClick={load} style={{ gap: 8 }}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Top KPIs */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard
          label="REVENUE AT RISK"
          value={fmtCr(overview.revenue_at_risk)}
          sublabel={`${funnel?.total_detected?.toLocaleString() || '—'} opportunities detected`}
          color="var(--danger)"
          icon={AlertCircle}
        />
        <StatCard
          label="RECOVERABLE (EST.)"
          value={fmtCr(overview.recoverable_revenue)}
          sublabel="Based on per-category recoverability"
          color="var(--warning)"
          icon={Target}
        />
        <StatCard
          label="ACTUALLY RECOVERED"
          value={fmtCr(overview.revenue_recovered)}
          sublabel={`Recovery rate: ${fmtPct(overview.recovery_rate)}`}
          color="var(--success)"
          icon={ShieldCheck}
        />
        <StatCard
          label="AI UPLIFT VS BASELINE"
          value={agentVsBaseline?.uplift?.recovered_inr_diff ? `+₹${Math.round(agentVsBaseline.uplift.recovered_inr_diff / 100000).toFixed(1)}L` : '—'}
          sublabel={`${overview.blocked_actions} unsafe actions blocked`}
          color="var(--accent-primary)"
          icon={TrendingUp}
        />
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Active Cases', value: overview.active_cases, color: 'var(--accent-primary)', sub: 'pending + in_progress' },
          { label: 'Needs Human Approval', value: overview.pending_approval, color: 'var(--warning)', sub: 'below confidence threshold' },
          { label: 'Policy Blocked', value: overview.blocked_actions, color: 'var(--danger)', sub: 'guardrails fired' },
        ].map(card => (
          <div key={card.label} className="glass-panel" style={{ padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <p className="text-xs text-muted">{card.label}</p>
              <p className="text-h2" style={{ color: card.color, marginTop: 4 }}>{card.value}</p>
              <p className="text-xs text-muted" style={{ marginTop: 2 }}>{card.sub}</p>
            </div>
            <div style={{ width: 52, height: 52, borderRadius: 26, background: card.color + '22', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Activity size={22} color={card.color} />
            </div>
          </div>
        ))}
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-3 gap-6">
        {/* Timeline */}
        <div className="glass-panel" style={{ padding: '24px', gridColumn: 'span 2' }}>
          <div className="flex justify-between items-center" style={{ marginBottom: 20 }}>
            <div>
              <h2 className="text-h2">Recovery Timeline</h2>
              <p className="text-xs text-muted">Actual recovered amounts per day from database</p>
            </div>
          </div>
          <div style={{ height: 260 }}>
            {timeline.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={timeline} margin={{ left: -10 }}>
                  <defs>
                    <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" stroke="var(--text-muted)" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis stroke="var(--text-muted)" fontSize={11} tickLine={false} axisLine={false}
                    tickFormatter={v => v >= 100000 ? `${(v/100000).toFixed(0)}L` : `${(v/1000).toFixed(0)}k`} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                    formatter={(v: any) => [fmt(v), 'Recovered']}
                  />
                  <Area type="monotone" dataKey="recovered" stroke="#10b981" fill="url(#grad)" strokeWidth={2} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex justify-center items-center h-full text-muted text-sm">
                No recovery actions executed yet. Run the agent to populate this chart.
              </div>
            )}
          </div>
        </div>

        {/* Agent vs Baseline */}
        <div className="glass-panel" style={{ padding: '24px' }}>
          <h2 className="text-h2" style={{ marginBottom: 4 }}>REVIVE vs Baselines</h2>
          <p className="text-xs text-muted" style={{ marginBottom: 20 }}>Net Recovered Revenue on held-out test split</p>
          {agentVsBaseline ? (
            <div className="flex-col gap-3">
              {[
                { label: 'Always Retry', val: agentVsBaseline.baseline_always_retry?.net_revenue_inr || 0, color: '#ef4444' },
                { label: 'Rule-Based', val: agentVsBaseline.baseline_rule_based?.net_revenue_inr || 0, color: '#f59e0b' },
                { label: agentVsBaseline.eval_mode === 'live_gemini' ? 'REVIVE Live AI' : 'REVIVE Safe Fallback', val: agentVsBaseline.agent?.net_revenue_inr || 0, color: '#10b981' },
              ].map(item => (
                <div key={item.label}>
                  <div className="flex justify-between" style={{ marginBottom: 4 }}>
                    <span className="text-sm">{item.label}</span>
                    <span className="text-sm" style={{ color: item.color }}>{fmtCr(item.val)}</span>
                  </div>
                  <div className="progress-bg">
                    <div className="progress-fill" style={{ width: `${Math.min(100, (item.val / Math.max(1, agentVsBaseline.agent?.net_revenue_inr || 1)) * 100)}%`, background: item.color }} />
                  </div>
                </div>
              ))}
              <div className="p-3 rounded-md" style={{ background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.2)', marginTop: 8 }}>
                <p className="text-xs text-muted">Net Revenue Uplift vs Rule-Based</p>
                <p className="text-h2" style={{ color: 'var(--success)' }}>
                  {agentVsBaseline.uplift?.revive_vs_rule_based?.net_revenue_diff 
                    ? `+${fmtCr(agentVsBaseline.uplift.revive_vs_rule_based.net_revenue_diff)}` 
                    : '—'}
                </p>
              </div>
            </div>
          ) : <p className="text-muted text-sm">Run evaluation to see results</p>}
        </div>
      </div>

      {/* Recovery Funnel + By type */}
      <div className="grid grid-cols-2 gap-6">
        {/* Recovery Funnel */}
        <div className="glass-panel" style={{ padding: '24px' }}>
          <h2 className="text-h2" style={{ marginBottom: 4 }}>Recovery Funnel</h2>
          <p className="text-xs text-muted" style={{ marginBottom: 20 }}>Opportunity count at each stage</p>
          <div className="flex-col gap-3">
            {funnelData.map((stage) => (
              <div key={stage.name}>
                <div className="flex justify-between" style={{ marginBottom: 4 }}>
                  <span className="text-sm">{stage.name}</span>
                  <span className="text-sm" style={{ color: stage.fill }}>{stage.value.toLocaleString()}</span>
                </div>
                <div className="progress-bg">
                  <div className="progress-fill" style={{
                    width: funnelData[0].value > 0 ? `${(stage.value / funnelData[0].value) * 100}%` : '0%',
                    background: stage.fill
                  }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* By failure type */}
        <div className="glass-panel" style={{ padding: '24px' }}>
          <h2 className="text-h2" style={{ marginBottom: 4 }}>Cases by Failure Type</h2>
          <p className="text-xs text-muted" style={{ marginBottom: 20 }}>Opportunity count per root cause</p>
          <div style={{ height: 220 }}>
            {byType.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byType.slice(0, 6)} layout="vertical" margin={{ left: 10 }}>
                  <XAxis type="number" stroke="var(--text-muted)" fontSize={10} tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="opportunity_type" stroke="var(--text-muted)" fontSize={11}
                    tickLine={false} axisLine={false} width={120}
                    tickFormatter={v => v.replace('_', ' ')} />
                  <Tooltip contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="cnt" fill="var(--accent-primary)" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <p className="text-muted text-sm">No data yet. Seed the database first.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
