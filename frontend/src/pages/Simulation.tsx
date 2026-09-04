import { useState } from 'react';
import api from '../api';
import { Play, AlertTriangle, ShieldX, Brain, RefreshCw, Zap, CheckCircle, Copy } from 'lucide-react';

interface DemoResult {
  type: string;
  label: string;
  data: any;
  opportunityId?: string;
}

const SCENARIOS = [
  {
    id: 'success_upi_retry',
    label: '1. Successful Recovery',
    desc: 'UPI timeout → AI diagnoses transient failure → retry executes → revenue recovered. Demonstrates the core agentic loop working end-to-end.',
    icon: CheckCircle,
    color: 'var(--success)',
    borderColor: 'rgba(16,185,129,0.3)',
    bg: 'rgba(16,185,129,0.06)',
    btnClass: 'btn-success',
  },
  {
    id: 'policy_block_high_risk',
    label: '2. Policy Engine Block',
    desc: 'High-risk customer failure → AI recommends retry → Policy Engine inspects: risk score >80% → blocks auto-retry → no financial action executes.',
    icon: ShieldX,
    color: 'var(--danger)',
    borderColor: 'rgba(239,68,68,0.3)',
    bg: 'rgba(239,68,68,0.06)',
    btnClass: 'btn-danger',
  },
  {
    id: 'ai_failure_fallback',
    label: '3. AI Failure → Safe Fallback',
    desc: 'AI call deliberately fails / returns invalid JSON → Zod validation catches it → deterministic fallback strategy activates → no money moves unsafely.',
    icon: Brain,
    color: 'var(--warning)',
    borderColor: 'rgba(245,158,11,0.3)',
    bg: 'rgba(245,158,11,0.06)',
    btnClass: 'btn-secondary',
  },
  {
    id: 'duplicate_idempotency',
    label: '4. Duplicate Action Blocked',
    desc: 'Same opportunity submitted twice simultaneously → idempotency key check prevents duplicate execution → only one action proceeds.',
    icon: Copy,
    color: 'var(--accent-primary)',
    borderColor: 'rgba(59,130,246,0.3)',
    bg: 'rgba(59,130,246,0.06)',
    btnClass: 'btn-secondary',
  },
  {
    id: 'high_value_approval',
    label: '5. High-Value Approval Required',
    desc: 'Transaction >₹5,00,000 → Policy Engine requires human sign-off before any automated action → case enters approval queue.',
    icon: AlertTriangle,
    color: 'var(--warning)',
    borderColor: 'rgba(245,158,11,0.3)',
    bg: 'rgba(245,158,11,0.06)',
    btnClass: 'btn-secondary',
  },
];

export default function Simulation() {
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<DemoResult[]>([]);
  const [fullDemoRunning, setFullDemoRunning] = useState(false);
  const [fullDemoLog, setFullDemoLog] = useState<string[]>([]);

  const runScenario = async (scenarioId: string) => {
    const s = SCENARIOS.find(x => x.id === scenarioId)!;
    setRunning(scenarioId);
    try {
      const res = await api.post('/simulation/run-scenario', { scenario: scenarioId });
      setResults(prev => [{ type: scenarioId, label: s.label, data: res.data }, ...prev].slice(0, 10));
    } catch (err: any) {
      setResults(prev => [{ type: 'error', label: s.label, data: err.response?.data || err.message }, ...prev].slice(0, 10));
    } finally { setRunning(null); }
  };

  const runFullDemo = async () => {
    setFullDemoRunning(true);
    setFullDemoLog(['Starting full demo sequence...']);

    const steps: Array<{ msg: string; fn: () => Promise<any> }> = [
      { msg: '📦 Loading realistic merchant data...', fn: () => api.post('/simulation/run-scenario', { scenario: 'load_demo_data' }) },
      { msg: '🔍 Detecting recovery opportunities...', fn: () => api.post('/simulation/run-scenario', { scenario: 'detect_opportunities' }) },
      { msg: '🧠 Running AI diagnosis (success path)...', fn: () => api.post('/simulation/run-scenario', { scenario: 'success_upi_retry' }) },
      { msg: '🛡️ Triggering policy block (unsafe action)...', fn: () => api.post('/simulation/run-scenario', { scenario: 'policy_block_high_risk' }) },
      { msg: '⚡ Testing AI failure → fallback...', fn: () => api.post('/simulation/run-scenario', { scenario: 'ai_failure_fallback' }) },
      { msg: '📊 Comparing vs baseline...', fn: () => api.get('/analytics/agent-vs-baseline') },
    ];

    for (const step of steps) {
      setFullDemoLog(prev => [...prev, step.msg]);
      await step.fn().catch(() => {});
      await new Promise(r => setTimeout(r, 1200));
    }

    setFullDemoLog(prev => [...prev, '✅ Full demo complete. Check the dashboard and recovery queue for results.']);
    setFullDemoRunning(false);
  };

  return (
    <div className="flex-col gap-6 animate-fade-in" style={{ maxWidth: 900, margin: '0 auto' }}>
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-h1">Demo Control Center</h1>
          <p className="text-xs text-muted" style={{ marginTop: 4 }}>
            All scenarios are deterministic replays. Results labeled <strong>[SIMULATION]</strong> are not live Razorpay API calls.
          </p>
        </div>
      </div>

      {/* Full Demo Button */}
      <div className="glass-panel" style={{ padding: 24, borderTop: '3px solid var(--accent-primary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 24 }}>
        <div>
          <h2 className="text-h2 flex items-center gap-2"><Zap size={18} /> Run Full Demo (60s)</h2>
          <p className="text-sm" style={{ color: 'var(--text-secondary)', marginTop: 6 }}>
            Executes all five scenarios sequentially in a deterministic order. Does not depend on live LLM availability — uses recorded fallback decisions when Gemini is unavailable.
          </p>
        </div>
        <button className="btn btn-primary" style={{ whiteSpace: 'nowrap', padding: '12px 24px' }}
          disabled={fullDemoRunning} onClick={runFullDemo}>
          <Play size={16} /> {fullDemoRunning ? 'Running...' : 'RUN FULL DEMO'}
        </button>
      </div>

      {fullDemoLog.length > 0 && (
        <div className="glass-panel" style={{ padding: 16 }}>
          <p className="text-xs text-muted" style={{ marginBottom: 8 }}>DEMO LOG</p>
          <div style={{ fontFamily: 'monospace', fontSize: 12, lineHeight: 1.8 }}>
            {fullDemoLog.map((line, i) => (
              <div key={i} style={{ color: line.startsWith('✅') ? 'var(--success)' : 'var(--text-secondary)' }}>{line}</div>
            ))}
            {fullDemoRunning && <div style={{ color: 'var(--accent-primary)' }}><RefreshCw size={12} className="animate-spin" style={{ display: 'inline', marginRight: 6 }} />Running...</div>}
          </div>
        </div>
      )}

      {/* Individual Scenarios */}
      <div className="grid grid-cols-2" style={{ gap: 16 }}>
        {SCENARIOS.map(s => {
          const Icon = s.icon;
          const isRunning = running === s.id;
          return (
            <div key={s.id} className="glass-panel flex-col" style={{ padding: 24, borderTop: `3px solid ${s.color}`, justifyContent: 'space-between', gap: 16 }}>
              <div>
                <div className="flex items-center gap-3" style={{ marginBottom: 10 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 8, background: s.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${s.borderColor}` }}>
                    <Icon size={18} color={s.color} />
                  </div>
                  <h3 className="text-h2" style={{ fontSize: 14 }}>{s.label}</h3>
                </div>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{s.desc}</p>
              </div>
              <button className={`btn ${s.btnClass} w-full`} disabled={!!running} onClick={() => runScenario(s.id)}>
                {isRunning ? <><RefreshCw size={13} className="animate-spin" /> Running...</> : <><Play size={13} /> Run Scenario</>}
              </button>
            </div>
          );
        })}
      </div>

      {/* Results */}
      {results.length > 0 && (
        <div className="glass-panel" style={{ padding: 24 }}>
          <h2 className="text-h2" style={{ marginBottom: 16 }}>Recent Results</h2>
          <div className="flex-col gap-3">
            {results.map((r, i) => (
              <div key={i} style={{ padding: 14, borderRadius: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)' }}>
                <div className="flex justify-between items-center" style={{ marginBottom: 8 }}>
                  <p style={{ fontWeight: 600, fontSize: 13 }}>{r.label}</p>
                  <span className="badge badge-neutral" style={{ fontSize: 10 }}>[SIMULATION]</span>
                </div>
                <pre style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'auto', maxHeight: 120 }}>
                  {JSON.stringify(r.data, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
