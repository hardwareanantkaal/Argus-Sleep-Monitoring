'use client';

// Small building blocks shared by the screens, matching the mockup markup and classes.

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { errText, get } from '@/lib/api';
import { COUNTRIES, placeName, sameZone } from '@/lib/format';
import type { DevicePerm, StageMin } from '@/lib/types';
import { anyMock } from '@/lib/config';

export const FAM_PERMS: [DevicePerm, string][] = [
  ['live.view', 'See live values'],
  ['history.view', 'See sleep history'],
  ['alerts.receive', 'Get alerts'],
  ['settings.edit', 'Change device settings'],
  ['sharing.manage', 'Invite and manage people'],
];
export const permLabel = (p: string) => FAM_PERMS.find((f) => f[0] === p)?.[1] || p;

/** Load a GET path; `null` path = don't load yet. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(!!path);
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    setError(null);
    try { setData(await get<T>(path)); } catch (e) { setError(e); } finally { setLoading(false); }
  }, [path]);
  useEffect(() => { load(); }, [load]);
  return { data, setData, error, loading, reload: load };
}

export function Head({ title, sub, actions, back }: { title: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode; back?: [string, string] }) {
  return (
    <div className="head">
      <div className="t">
        {back && <Link className="crumb" href={back[0]}><Icon name="back" size={16} />{back[1]}</Link>}
        <h1>{title}</h1>
        {sub && <p className="muted small">{sub}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="loading"><span className="spinner" />{label}</div>;
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="banner" role="alert">
      <Icon name="alert" />
      <span style={{ flex: 1 }}>{errText(error)}</span>
      {retry && <button className="btn ghost sm" onClick={retry}>Try again</button>}
    </div>
  );
}

/** Wraps the usual loading / error / data states. */
export function Async<T>({ q, children }: { q: { data: T | undefined; error: unknown; loading: boolean; reload: () => void }; children: (d: T) => React.ReactNode }) {
  if (q.error) return <ErrorBox error={q.error} retry={q.reload} />;
  if (q.data === undefined) return <Loading />;
  return <>{children(q.data)}</>;
}

export function Locked({ msg, home = '/' }: { msg?: string; home?: string }) {
  return (
    <div className="card lock">
      <Icon name="shield" size={30} />
      <h2>No access</h2>
      <p>{msg || 'Your role does not include this permission. Ask an owner to turn it on.'}</p>
      <Link className="btn ghost" href={home}>Go to home</Link>
    </div>
  );
}

/** Marks values that are still placeholders until checked on real hardware (DEVICE-DATA ⚠). */
export const PH = () => <span className="ph">placeholder</span>;

export function MockBadge() {
  return anyMock ? <span className="mockbadge" title="Some screens use built-in sample data">Sample data</span> : null;
}

export function StatusPill({ online }: { online: boolean }) {
  return online
    ? <span className="pill ok"><span className="dot" />Online</span>
    : <span className="pill bad"><span className="dot" />Offline</span>;
}

/** "Surat time" label, only when the viewer is in another zone. */
export function TzTag({ tz, place }: { tz: string; place: string | null | undefined }) {
  const [show, setShow] = useState(false);
  useEffect(() => setShow(!sameZone(tz)), [tz]); // client only: the server doesn't know the viewer's zone
  if (!show) return null;
  return <> <span className="pill acc" title={tz} style={{ verticalAlign: 'middle' }}><Icon name="clock" size={13} /> {placeName(tz, place)} time</span></>;
}

export function ScoreRing({ v, lg }: { v: number; lg?: boolean }) {
  const r = lg ? 48 : 19, c = 2 * Math.PI * r, sw = lg ? 9 : 4, sz = lg ? 112 : 46;
  const col = v >= 80 ? 'var(--ok)' : v >= 65 ? 'var(--accent)' : 'var(--warn)';
  return (
    <div className={`score${lg ? ' lg' : ''}`} aria-label={`Score ${v}`}>
      <svg viewBox={`0 0 ${sz} ${sz}`}>
        <circle cx={sz / 2} cy={sz / 2} r={r} fill="none" stroke="var(--panel-2)" strokeWidth={sw} />
        <circle cx={sz / 2} cy={sz / 2} r={r} fill="none" stroke={col} strokeWidth={sw} strokeLinecap="round" strokeDasharray={`${(c * v) / 100} ${c}`} />
      </svg>
      <b>{v}</b>
    </div>
  );
}

export const STAGES: [keyof StageMin, string, string][] = [
  ['deep', 'Deep', 'c-deep'], ['light', 'Light', 'c-light'], ['awake', 'Awake', 'c-awake'], ['outOfBed', 'Out of bed', 'c-oob'],
];

export function StageBar({ m }: { m: StageMin }) {
  const total = m.deep + m.light + m.awake + m.outOfBed || 1;
  return <div className="sbar">{STAGES.map(([k, , c]) => <i key={k} className={c} style={{ width: `${(m[k] / total) * 100}%` }} />)}</div>;
}

export function Legend() {
  return <div className="legend">{STAGES.map(([k, l, c]) => <span key={k}><i className={c} />{l}</span>)}</div>;
}

export function PermToggles({ on, onChange, disabled, allowed }: { on: DevicePerm[]; onChange(p: DevicePerm[]): void; disabled?: boolean; allowed?: DevicePerm[] }) {
  return (
    <>
      {FAM_PERMS.map(([k, l]) => {
        const off = disabled || (allowed && !allowed.includes(k));
        return (
          <label className="tog" key={k}>
            <span className="t"><span>{l}</span><span className="xs muted mono">{k}</span></span>
            <input type="checkbox" className="sw" checked={on.includes(k)} disabled={off}
              onChange={(e) => onChange(e.target.checked ? [...on, k] : on.filter((x) => x !== k))} />
          </label>
        );
      })}
    </>
  );
}

/** Country-code select + local number. Codes are unique per select value (US and CA share +1). */
export function PhoneInput({ code, setCode, local, setLocal, id }: { code: string; setCode(c: string): void; local: string; setLocal(v: string): void; id: string }) {
  const codes = [...new Set(COUNTRIES.map((c) => c.code))];
  const short = (code: string) => COUNTRIES.filter((c) => c.code === code).map((c) => c.iso).join('/');
  return (
    <div className="phone">
      <select className="inp" aria-label="Country code" value={code} onChange={(e) => setCode(e.target.value)}>
        {codes.map((c) => <option key={c} value={c}>{c} {short(c)}</option>)}
      </select>
      <input className="inp" id={id} inputMode="tel" autoComplete="tel-national" value={local} onChange={(e) => setLocal(e.target.value)} placeholder="98250 12345" />
    </div>
  );
}

export function TzSelect({ id, value, onChange, options }: { id: string; value: string; onChange(v: string): void; options: string[] }) {
  const list = [...new Set([value, ...options].filter(Boolean))];
  return (
    <select className="inp" id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {list.map((z) => <option key={z} value={z}>{z}</option>)}
    </select>
  );
}

/** Copy to the clipboard, with a fallback for http:// (dev) where the Clipboard API is blocked. */
export async function copyText(t: string) {
  try { await navigator.clipboard.writeText(t); return true; } catch {
    const a = document.createElement('textarea');
    a.value = t; document.body.appendChild(a); a.select();
    const ok = document.execCommand('copy'); a.remove(); return ok;
  }
}

/** A placeholder screen so navigation works before the screen is built. */
export function Placeholder({ title, sub, stage, items, back }: { title: string; sub?: string; stage: string; items: string[]; back?: [string, string] }) {
  return (
    <div className="wrap narrow">
      <Head title={title} sub={sub} back={back} />
      <div className="card stack">
        <div className="row"><span className="pill warn">Coming in {stage}</span></div>
        <p className="small muted">This screen is not built yet. It will show:</p>
        <ul className="small" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {items.map((i) => <li key={i}>{i}</li>)}
        </ul>
        <p className="xs muted">Approved design: mockup/index.html · data: docs/SCREENS.md</p>
      </div>
    </div>
  );
}
