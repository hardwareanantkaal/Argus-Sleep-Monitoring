'use client';

// Factory log (API.md 9.28–9.29): every board flashed or tested on a bench, newest first. Read-only.

import Link from 'next/link';
import { Fragment, useEffect, useState } from 'react';
import { macUpper, ResultPill } from '@/components/factory';
import { Icon } from '@/components/Icon';
import { useAuth } from '@/components/Providers';
import { RequireStaff } from '@/components/Shell';
import { Head } from '@/components/ui';
import { errText, get, qs } from '@/lib/api';
import { CHECKS } from '@/lib/checks';
import { dateTime } from '@/lib/format';
import type { FactoryRun, FactoryRunList } from '@/lib/types';

const RANGES: [string, string][] = [['today', 'Today'], ['7d', 'Last 7 days'], ['any', 'All time']];
function fromIso(range: string) {
  if (range === 'any') return undefined;
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (range === '7d') d.setDate(d.getDate() - 6);
  return d.toISOString();
}

export default function FactoryLogPage() {
  return <RequireStaff perm="devices.view"><Inner /></RequireStaff>;
}

function Inner() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [result, setResult] = useState('');
  const [range, setRange] = useState('today');
  const [data, setData] = useState<FactoryRunList | null>(null);
  const [more, setMore] = useState<{ items: FactoryRun[]; next: number | null }[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [detail, setDetail] = useState<FactoryRun | null>(null);
  const [err, setErr] = useState('');

  const path = (cursor?: number | null) => `/admin/factory/runs${qs({ limit: 50, q: q.trim(), result, from: fromIso(range), cursor })}`;

  useEffect(() => {
    const t = setTimeout(() => {
      get<FactoryRunList>(path()).then((d) => { setData(d); setMore([]); setErr(''); }).catch((e) => setErr(errText(e)));
    }, 250);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, result, range]);

  const nextCursor = more.length ? more[more.length - 1].next : data?.nextCursor;
  async function loadMore() {
    try { const d = await get<FactoryRunList>(path(nextCursor)); setMore([...more, { items: d.items, next: d.nextCursor }]); } catch (e) { setErr(errText(e)); }
  }
  async function toggle(id: number) {
    if (open === id) { setOpen(null); return; }
    setOpen(id); setDetail(null);
    setDetail(await get<FactoryRun>(`/admin/factory/runs/${id}`).catch(() => null));
  }

  const s = data?.summary;
  const done = s ? s.pass + s.fail : 0;
  const rows = data ? [...data.items, ...more.flatMap((m) => m.items)] : [];

  return (
    <div className="wrap">
      <Head title="Factory log" sub="Every board flashed or tested on a bench, newest first. Read-only."
        actions={can('factory.monitor') && <Link className="btn" href="/admin/station"><Icon name="bolt" /> Open the station</Link>} />
      {err && <p className="err" role="alert">{err}</p>}
      {s && <div className="tiles">
        <div className="card tile"><span className="label">Passed</span><div className="v" style={{ color: 'var(--ok)' }}>{s.pass}</div><span className="xs muted">{RANGES.find((r) => r[0] === range)?.[1]}</span></div>
        <div className="card tile"><span className="label">Failed</span><div className="v" style={{ color: 'var(--bad)' }}>{s.fail}</div>
          <span className="xs muted">{s.byReason.slice(0, 3).map((r) => `${r.reason} ${r.n}`).join(' · ') || '—'}</span></div>
        <div className="card tile"><span className="label">Pass rate</span><div className="v">{done ? Math.round((s.pass / done) * 100) : 0}<small>%</small></div><span className="xs muted">{s.aborted} aborted, not counted</span></div>
        <div className="card tile"><span className="label">By person</span><div className="stack" style={{ gap: 2, marginTop: 8 }}>
          {s.byOperator.length ? s.byOperator.map((o) => <span key={o.operatorName} className="small">{o.operatorName}: <b className="num">{o.pass}</b> pass · <b className="num">{o.fail}</b> fail</span>) : <span className="small muted">—</span>}</div></div>
      </div>}
      <div className="card">
        <div className="toolbar">
          <input className="inp" placeholder="Search MAC or serial" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search MAC or serial" />
          <select className="inp" value={result} onChange={(e) => setResult(e.target.value)} aria-label="Result">
            <option value="">All results</option><option value="pass">Pass</option><option value="fail">Fail</option><option value="aborted">Aborted</option><option value="running">Running</option></select>
          <select className="inp" value={range} onChange={(e) => setRange(e.target.value)} aria-label="Time">{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </div>
        <div className="tbl"><table><thead><tr><th>Time</th><th>MAC</th><th>Serial</th><th>Firmware</th><th>Result</th><th>By</th><th>Bench</th><th /></tr></thead><tbody>
          {rows.map((r) => (
            <Fragment key={r.id}>
              <tr className="click" onClick={() => toggle(r.id)}>
                <td className="muted">{dateTime(r.startedAt)}</td><td className="mono">{macUpper(r.mac)}</td>
                <td className="mono">{r.serial || <span className="muted">—</span>}</td><td className="mono">{r.fwVersion || '—'}</td>
                <td><ResultPill r={r} /></td><td>{r.operatorName}</td><td className="muted">{r.station || '—'}</td>
                <td><Icon name="chev" size={16} /></td></tr>
              {open === r.id && <tr className="runrow"><td colSpan={8} style={{ whiteSpace: 'normal' }}>
                {!detail ? <span className="muted small">Loading…</span> : <div className="stack" style={{ gap: 10, padding: '4px 0' }}>
                  <div className="chips">{CHECKS.map((c) => {
                    const x = (detail.checks || []).find((k) => k.id === c.id);
                    const cls = !x || x.ok === null ? '' : x.ok ? 'ok' : 'bad';
                    return <span key={c.id} className={`pill ${cls}`} title={x?.value || ''}>{!x || x.ok === null ? '–' : x.ok ? '✓' : '✕'} {c.label}{x?.value ? `: ${x.value}` : ''}</span>;
                  })}</div>
                  <div className="xs muted">Run #{detail.id} · {detail.chip} · {detail.flashed ? `flashed ${detail.fwVersion}${detail.flashMs ? ` in ${(detail.flashMs / 1000).toFixed(0)} s` : ''}` : 'not flashed (test only)'}
                    {detail.finishedAt ? ` · took ${Math.round((Date.parse(detail.finishedAt) - Date.parse(detail.startedAt)) / 1000)} s` : ''}{detail.notes ? ` · note: ${detail.notes}` : ''}</div>
                  {detail.logTail ? <div className="term" style={{ maxHeight: 260, whiteSpace: 'pre-wrap' }}>{detail.logTail}</div> : <span className="xs muted">No serial log saved.</span>}
                  <span className="xs muted">The last 16 KB of serial output is kept per board. Live values are not saved.</span>
                  {detail.deviceId && <Link className="link small" href={`/admin/devices/${detail.deviceId}`}>Open device {detail.serial}</Link>}
                </div>}</td></tr>}
            </Fragment>
          ))}
          {data && !rows.length && <tr><td colSpan={8} className="muted">No runs match.</td></tr>}
        </tbody></table></div>
        {nextCursor && <div style={{ marginTop: 16 }}><button className="btn ghost sm" onClick={loadMore}>Load more</button></div>}
      </div>
    </div>
  );
}
