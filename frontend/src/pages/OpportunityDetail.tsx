import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '../api';
import {
  ArrowLeft, CheckCircle, XCircle, Clock, ShieldCheck, ShieldX,
  Brain, User, Play
} from 'lucide-react';
import { format } from 'date-fns';

const fmtINR = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;
const fmtDate = (iso: string) => { try { return format(new Date(iso), 'MMM d, HH:mm:ss'); } catch { return iso; } };

export default function OpportunityDetail() {
  const { id } = useParams();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    try {
      const res = await api.get(`/opportunities/${id}`);
      setData(res.data);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  useEffect(() => { reload(); }, [id]);

  const handleRun = async () => {
    await api.post(`/agent/run/${id}`);
    reload();
  };

  const handleApprove = async (actionId: string) => {
    await api.post(`/agent/approve/${actionId}`);
    reload();
  };

  if (loading) return <div className="flex justify-center p-16 text-muted">Loading case...</div>;
  if (!data) return <div className="flex justify-center p-16 text-danger">Case not found.</div>;

  const { opportunity: opp, decisions, actions, audit_trail } = data;
  const decision = decisions?.[0];
  const pendingAction = actions?.find((a: any) => a.status === 'awaiting_approval');
  const successAction = actions?.find((a: any) => a.status === 'success');
  const blockedChecks = decision?.checks_raw
    ?.split('|')
    .map((c: string) => {
      const [name, passed, reason] = c.split(':');
      return { name, passed: passed === '1', reason };
    })
    .filter((c: any) => !c.passed) || [];

  const rejectedActions: any[] = [];
  try { if (decision?.rejected_actions) rejectedActions.push(...JSON.parse(decision.rejected_actions)); } catch {}

  const statusColors: Record<string, string> = {
    recovered: 'var(--success)', blocked: 'var(--danger)',
    awaiting_approval: 'var(--warning)', failed: 'var(--text-muted)',
    in_progress: 'var(--accent-primary)', pending: 'var(--text-muted)',
  };

  return (
    <div className="flex-col gap-6 animate-fade-in">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-4">
          <Link to="/opportunities" className="btn btn-secondary" style={{ padding: 8 }}><ArrowLeft size={16} /></Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-h1">Case {id?.split('-')[0]}</h1>
              <span style={{ padding: '4px 12px', borderRadius: 12, background: (statusColors[opp.status] || 'var(--text-muted)') + '20', color: statusColors[opp.status] || 'var(--text-muted)', fontSize: 12, fontWeight: 600, letterSpacing: '0.05em' }}>
                {opp.status.replace('_', ' ').toUpperCase()}
              </span>
            </div>
            <p className="text-xs text-muted" style={{ marginTop: 4 }}>
              {opp.opportunity_type?.replace('_', ' ')} &bull; Created {fmtDate(opp.created_at)}
            </p>
          </div>
        </div>
        {opp.status === 'pending' && (
          <button className="btn btn-primary" onClick={handleRun}><Play size={14} /> Run AI Agent</button>
        )}
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Left 2 columns */}
        <div className="flex-col gap-6" style={{ gridColumn: 'span 2' }}>

          {/* Customer + Transaction Context */}
          <div className="glass-panel" style={{ padding: 24 }}>
            <h2 className="text-h2 flex items-center gap-2" style={{ marginBottom: 20 }}>
              <User size={16} /> Customer & Transaction Context
            </h2>
            <div className="grid grid-cols-3 gap-6" style={{ marginBottom: 20 }}>
              <div>
                <p className="text-xs text-muted">CUSTOMER</p>
                <p style={{ fontWeight: 600, marginTop: 4 }}>{opp.customer_name}</p>
                <p className="text-xs text-muted">{opp.customer_email}</p>
              </div>
              <div>
                <p className="text-xs text-muted">AMOUNT AT RISK</p>
                <p style={{ fontWeight: 700, color: 'var(--danger)', marginTop: 4, fontSize: 18 }}>{fmtINR(opp.amount)}</p>
              </div>
              <div>
                <p className="text-xs text-muted">LIFETIME VALUE</p>
                <p style={{ fontWeight: 600, marginTop: 4 }}>{fmtINR(opp.lifetime_value || 0)}</p>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-6" style={{ paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              {[
                { label: 'RISK SCORE', value: `${Math.round((opp.risk_score || 0) * 100)}%`, color: opp.risk_score > 0.7 ? 'var(--danger)' : opp.risk_score > 0.4 ? 'var(--warning)' : 'var(--success)' },
                { label: 'FAILURE REASON', value: opp.failure_reason || 'Unknown', color: null },
                { label: 'PAYMENT METHOD', value: opp.payment_method || 'N/A', color: null },
                { label: 'GATEWAY ERROR', value: opp.gateway_error_code || 'None', color: null },
              ].map(f => (
                <div key={f.label}>
                  <p className="text-xs text-muted">{f.label}</p>
                  <p style={{ fontWeight: 500, marginTop: 4, color: f.color || 'var(--text-primary)', fontSize: 13 }}>{f.value}</p>
                </div>
              ))}
            </div>
          </div>

          {/* AI Decision */}
          {decision && (
            <div className="glass-panel" style={{ padding: 24, borderLeft: `3px solid ${decision.is_fallback ? 'var(--warning)' : 'var(--accent-primary)'}` }}>
              <div className="flex justify-between items-start" style={{ marginBottom: 20 }}>
                <h2 className="text-h2 flex items-center gap-2">
                  <Brain size={16} />
                  {decision.is_fallback ? 'Deterministic Fallback Decision' : 'AI Diagnosis & Decision'}
                  {decision.is_fallback
                    ? <span className="badge badge-warning" style={{ fontSize: 10 }}>FALLBACK</span>
                    : <span className="badge badge-primary" style={{ fontSize: 10 }}>GEMINI AI</span>}
                </h2>
                <div style={{ textAlign: 'right' }}>
                  <p className="text-xs text-muted">RECOMMENDED</p>
                  <span className="badge badge-primary" style={{ marginTop: 4 }}>{decision.recommended_action?.replace(/_/g, ' ')}</span>
                  <p className="text-xs text-muted" style={{ marginTop: 4 }}>Confidence: {Math.round((decision.confidence || 0) * 100)}%</p>
                </div>
              </div>

              {/* Diagnosis */}
              <div style={{ marginBottom: 16 }}>
                <p className="text-xs text-muted" style={{ marginBottom: 6 }}>ROOT CAUSE DIAGNOSIS</p>
                <p style={{ fontSize: 14 }}>{decision.diagnosis}</p>
                {decision.root_cause_category && (
                  <span className="badge badge-neutral" style={{ marginTop: 8, fontSize: 11 }}>{decision.root_cause_category.replace('_', ' ')}</span>
                )}
              </div>

              {/* Reasoning */}
              <div style={{ padding: 16, borderRadius: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', marginBottom: 16 }}>
                <p className="text-xs text-muted" style={{ marginBottom: 8 }}>AGENT REASONING</p>
                <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)' }}>{decision.reasoning}</p>
              </div>

              {/* Why alternatives were rejected */}
              {rejectedActions.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <p className="text-xs text-muted" style={{ marginBottom: 8 }}>ALTERNATIVES CONSIDERED & REJECTED</p>
                  <div className="flex-col gap-2">
                    {rejectedActions.map((r: any, i: number) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 12px', background: 'rgba(239, 68, 68, 0.05)', borderRadius: 6, border: '1px solid rgba(239, 68, 68, 0.15)' }}>
                        <XCircle size={14} style={{ color: 'var(--danger)', marginTop: 2, flexShrink: 0 }} />
                        <div>
                          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>{r.action?.replace(/_/g, ' ')} </span>
                          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>— {r.reason}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Counterfactual: what baseline would do */}
              {decision.baseline_action && (
                <div style={{ padding: 12, borderRadius: 8, background: 'rgba(100, 116, 139, 0.08)', border: '1px solid var(--border)' }}>
                  <p className="text-xs text-muted" style={{ marginBottom: 6 }}>WHAT "ALWAYS RETRY" BASELINE WOULD HAVE DONE</p>
                  <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                    <strong style={{ color: 'var(--text-primary)' }}>{decision.baseline_action.replace(/_/g, ' ')}</strong>
                    {decision.baseline_reasoning ? ` — ${decision.baseline_reasoning}` : ''}
                  </p>
                </div>
              )}

              {/* Policy blocked */}
              {opp.status === 'blocked' && blockedChecks.length > 0 && (
                <div style={{ marginTop: 16, padding: 16, borderRadius: 8, background: 'var(--danger-bg)', border: '1px solid rgba(239,68,68,0.3)' }}>
                  <div className="flex items-center gap-2" style={{ marginBottom: 8 }}>
                    <ShieldX size={16} style={{ color: 'var(--danger)' }} />
                    <p style={{ fontWeight: 600, color: 'var(--danger)' }}>Action Blocked by Policy Engine</p>
                  </div>
                  {blockedChecks.map((c: any, i: number) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 6 }}>
                      <XCircle size={13} style={{ color: 'var(--danger)', marginTop: 2 }} />
                      <div>
                        <code style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.name}</code>
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginLeft: 6 }}>{c.reason}</span>
                      </div>
                    </div>
                  ))}
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10, fontStyle: 'italic' }}>
                    No financial action was executed. This block is deterministic and not overrideable by AI.
                  </p>
                </div>
              )}

              {/* Human approval */}
              {pendingAction && (
                <div style={{ marginTop: 16, padding: 16, borderRadius: 8, background: 'var(--warning-bg)', border: '1px solid rgba(245,158,11,0.3)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
                  <div>
                    <p style={{ fontWeight: 600, color: 'var(--warning)' }}>Human Approval Required</p>
                    <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                      Confidence {Math.round(decision.confidence * 100)}% is below the approval threshold, or risk level is critical.
                    </p>
                  </div>
                  <button className="btn btn-primary" onClick={() => handleApprove(pendingAction.id)} style={{ whiteSpace: 'nowrap' }}>
                    <ShieldCheck size={14} /> Approve & Execute
                  </button>
                </div>
              )}

              {/* Success outcome */}
              {successAction && (
                <div style={{ marginTop: 16, padding: 16, borderRadius: 8, background: 'var(--success-bg)', border: '1px solid rgba(16,185,129,0.3)' }}>
                  <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
                    <CheckCircle size={16} style={{ color: 'var(--success)' }} />
                    <p style={{ fontWeight: 600, color: 'var(--success)' }}>Recovery Successful</p>
                  </div>
                  <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                    Recovered <strong style={{ color: 'var(--success)' }}>{fmtINR(successAction.outcome_amount)}</strong> via {successAction.action_type.replace(/_/g, ' ')}
                    {successAction.approved_by ? ` (approved by ${successAction.approved_by})` : ' (auto-executed)'}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Audit Trail */}
        <div className="glass-panel" style={{ padding: 24, display: 'flex', flexDirection: 'column', maxHeight: '80vh' }}>
          <h2 className="text-h2 flex items-center gap-2" style={{ marginBottom: 20 }}>
            <Clock size={16} /> Full Audit Trail
          </h2>
          <div style={{ flex: 1, overflowY: 'auto', paddingRight: 4 }}>
            <div style={{ position: 'relative' }}>
              <div style={{ position: 'absolute', left: 8, top: 0, bottom: 0, width: 1, background: 'var(--border)' }} />
              <div className="flex-col gap-5">
                {(audit_trail || []).map((log: any) => {
                  const isAI = log.is_ai_decision === 1;
                  const isSuccess = log.event_type.includes('success');
                  const isFail = log.event_type.includes('fail') || log.event_type.includes('block');
                  const Icon = isSuccess ? CheckCircle : isFail ? XCircle : Clock;
                  const color = isSuccess ? 'var(--success)' : isFail ? 'var(--danger)' : isAI ? 'var(--accent-secondary)' : 'var(--accent-primary)';

                  return (
                    <div key={log.id} style={{ display: 'flex', gap: 14, paddingLeft: 4 }}>
                      <div style={{ background: 'var(--bg-primary)', borderRadius: '50%', padding: 2, zIndex: 1, flexShrink: 0 }}>
                        <Icon size={14} color={color} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <div className="flex items-center gap-2" style={{ marginBottom: 2 }}>
                          <p style={{ fontSize: 12, fontWeight: 600 }}>{log.event_type.replace(/_/g, ' ')}</p>
                          {isAI && <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: 'rgba(139, 92, 246, 0.2)', color: 'var(--accent-secondary)', fontWeight: 700 }}>AI</span>}
                        </div>
                        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                          {fmtDate(log.timestamp)} &bull; {log.actor}
                        </p>
                        <div style={{ padding: '8px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', fontSize: 12, lineHeight: 1.5 }}>
                          {log.description}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
