import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import { Search, ChevronRight, RefreshCw, Brain } from 'lucide-react';

const fmtINR = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  recovered:         { label: 'Recovered',       cls: 'badge-success' },
  failed:            { label: 'Failed',           cls: 'badge-neutral' },
  blocked:           { label: 'Policy Blocked',   cls: 'badge-danger' },
  awaiting_approval: { label: 'Needs Approval',   cls: 'badge-warning' },
  in_progress:       { label: 'In Progress',      cls: 'badge-primary' },
  pending:           { label: 'Pending',           cls: 'badge-neutral' },
};

export default function Opportunities() {
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [filterStatus, setFilterStatus] = useState('');
  const [query, setQuery] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (filterStatus) params.set('status', filterStatus);
      const res = await api.get(`/opportunities?${params}`);
      setItems(res.data.items);
      setTotal(res.data.total);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  const runBatch = async () => {
    setRunning(true);
    try { await api.post('/agent/run-batch', { limit: 20 }); await load(); }
    catch (err) { console.error(err); }
    finally { setRunning(false); }
  };

  useEffect(() => { load(); }, [filterStatus]);

  const visible = query
    ? items.filter(i => i.customer_name?.toLowerCase().includes(query.toLowerCase()) ||
                        i.failure_reason?.toLowerCase().includes(query.toLowerCase()))
    : items;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, height: '100%' }}>
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-h1">Recovery Queue</h1>
          <p className="text-xs text-muted" style={{ marginTop: 4 }}>{total.toLocaleString()} total opportunities</p>
        </div>
        <div className="flex gap-3">
          <button className="btn btn-secondary" onClick={load}><RefreshCw size={14} /> Refresh</button>
          <button className="btn btn-primary" disabled={running} onClick={runBatch}>
            <Brain size={14} /> {running ? 'Running...' : 'Run AI Agent (20 cases)'}
          </button>
        </div>
      </div>

      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
        {/* Filters */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: 1, maxWidth: 340 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--text-muted)' }} />
            <input type="text" placeholder="Search customer or failure..." value={query}
              onChange={e => setQuery(e.target.value)}
              style={{ width: '100%', padding: '7px 10px 7px 32px', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', borderRadius: 6, color: 'white', outline: 'none', fontSize: 13 }}
            />
          </div>
          {['', 'pending', 'in_progress', 'recovered', 'blocked', 'awaiting_approval'].map(s => (
            <button key={s || 'all'} onClick={() => setFilterStatus(s)}
              className={`btn ${filterStatus === s ? 'btn-primary' : 'btn-secondary'}`}
              style={{ padding: '6px 12px', fontSize: 12 }}>
              {s === '' ? 'All' : STATUS_BADGE[s]?.label || s}
            </button>
          ))}
        </div>

        {/* Table */}
        <div className="table-container" style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <div className="flex justify-center p-8"><RefreshCw size={24} style={{ animation: 'spin 1s linear infinite', color: 'var(--accent-primary)' }} /></div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Amount at Risk</th>
                  <th>Failure</th>
                  <th>AI Recommendation</th>
                  <th>Confidence</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visible.map(item => {
                  const badge = STATUS_BADGE[item.status] || { label: item.status, cls: 'badge-neutral' };
                  return (
                    <tr key={item.id}>
                      <td>
                        <div className="flex items-center gap-3">
                          <div style={{
                            width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
                            background: `hsl(${(item.customer_name?.charCodeAt(0) || 65) * 8}, 60%, 35%)`,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 13
                          }}>
                            {item.customer_name?.charAt(0) || '?'}
                          </div>
                          <div>
                            <div style={{ fontWeight: 500, fontSize: 13 }}>{item.customer_name}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{item.customer_email}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div style={{ fontWeight: 600, color: 'var(--danger)', fontVariantNumeric: 'tabular-nums' }}>{fmtINR(item.amount)}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Risk: {Math.round(item.risk_score * 100)}%</div>
                      </td>
                      <td>
                        <div style={{ fontSize: 13 }}>{item.failure_reason || 'Unknown'}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{item.opportunity_type?.replace('_', ' ')}</div>
                      </td>
                      <td>
                        {item.recommended_action ? (
                          <span className="badge badge-primary" style={{ fontSize: 11 }}>
                            {item.recommended_action.replace(/_/g, ' ')}
                          </span>
                        ) : (
                          <span style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>Pending analysis</span>
                        )}
                      </td>
                      <td>
                        {item.confidence != null ? (
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 500 }}>{Math.round(item.confidence * 100)}%</div>
                            <div className="progress-bg" style={{ width: 60, marginTop: 4 }}>
                              <div className="progress-fill" style={{
                                width: `${item.confidence * 100}%`,
                                background: item.confidence > 0.65 ? 'var(--success)' : item.confidence > 0.4 ? 'var(--warning)' : 'var(--danger)'
                              }} />
                            </div>
                          </div>
                        ) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                      </td>
                      <td><span className={`badge ${badge.cls}`}>{badge.label}</span></td>
                      <td>
                        <Link to={`/opportunities/${item.id}`} className="btn btn-secondary" style={{ padding: '4px 8px' }}>
                          <ChevronRight size={14} />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
