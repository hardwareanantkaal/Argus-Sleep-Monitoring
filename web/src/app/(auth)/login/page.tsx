'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AuthLayout, SupportCard, useNextParam } from '@/components/AuthLayout';
import { useAuth } from '@/components/Providers';
import { landingFor } from '@/components/Shell';
import { PhoneInput } from '@/components/ui';
import { errText } from '@/lib/api';
import { isLive } from '@/lib/config';
import { prettyPhone, toE164 } from '@/lib/format';

const DEMO = [
  ['+91', '9825012345', 'Priya Shah', 'customer, owns 3 sensors'],
  ['+971', '503182264', 'Rohan Shah', 'family, 2 shared sensors'],
  ['+91', '9898011223', 'Devam Gandhi', 'staff, Owner role'],
  ['+91', '9723044871', 'Kiran Patel', 'staff, Manufacturing'],
];

export default function LoginPage() {
  const { user, login } = useAuth();
  const router = useRouter();
  const next = useNextParam();
  const [code, setCode] = useState('+91');
  const [local, setLocal] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  // Already logged in (e.g. opened /login in a new tab): go on.
  useEffect(() => { if (user && !busy) router.replace(landingFor(user, next)); }, [user, busy, next, router]);

  const phone = toE164(code, local);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (local.replace(/\D/g, '').length < 6) return setErr('Enter your phone number');
    if (!pw) return setErr('Enter your password');
    setBusy(true);
    try {
      const u = await login(phone, pw);
      router.replace(landingFor(u, next));
    } catch (e2) {
      setErr(errText(e2));
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <div className="stack" style={{ gap: 6 }}><h1>Log in</h1><p className="muted">Use the phone number you signed up with.</p></div>
      {next?.startsWith('/invite/') && <div className="banner ok">Log in to accept your invite. You&apos;ll go straight back to it.</div>}
      <form className="form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="l-ph">Phone number</label>
          <PhoneInput id="l-ph" code={code} setCode={setCode} local={local} setLocal={setLocal} />
          {local && <span className="hint">Saved as <span className="mono">{phone}</span> (international E.164 format).</span>}
        </div>
        <div className="field">
          <label htmlFor="l-pw">Password</label>
          <input className="inp" id="l-pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </div>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn block" type="submit" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
      </form>
      <button className="link small" style={{ alignSelf: 'flex-start' }} onClick={() => setForgot(!forgot)} aria-expanded={forgot}>Forgot password?</button>
      {forgot && <SupportCard />}
      <p className="small muted">New here? <Link href={next ? `/signup?next=${encodeURIComponent(next)}` : '/signup'}>Create an account</Link></p>
      {!isLive('auth') && (
        <div className="note" style={{ flexDirection: 'column', gap: 6 }}>
          <span><b>Sample data mode.</b> Any password of 8+ characters works. Tap a person to fill in their number:</span>
          {DEMO.map(([c, l, n, d]) => (
            <button key={l} type="button" className="link small" style={{ textAlign: 'left' }} onClick={() => { setCode(c); setLocal(l); if (!pw) setPw('sleepwell24'); }}>
              {n} · {prettyPhone(c + l)} <span className="muted">({d})</span>
            </button>
          ))}
        </div>
      )}
    </AuthLayout>
  );
}
