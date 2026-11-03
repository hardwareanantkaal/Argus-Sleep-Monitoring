'use client';

// /reset/<token>: set a new password from a one-time link that support created (API.md 1.6 / 7.4).

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AuthLayout, SupportCard } from '@/components/AuthLayout';
import { useAuth } from '@/components/Providers';
import { ApiError, errText, post } from '@/lib/api';

export default function ResetPage() {
  const { token } = useParams<{ token: string }>();
  const { setUser } = useAuth();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [bad, setBad] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (pw.length < 8) return setErr('Password must be at least 8 characters');
    if (pw !== pw2) return setErr('The two passwords don’t match');
    setBusy(true);
    try {
      await post('/auth/password/reset', { token, newPassword: pw });
      setUser(null); // the reset logs the account out everywhere
      setDone(true);
    } catch (e2) {
      if (e2 instanceof ApiError && e2.code === 'RESET_TOKEN_INVALID') setBad(true);
      else setErr(errText(e2));
    } finally { setBusy(false); }
  };

  return (
    <AuthLayout>
      {done ? <>
        <h1>Password changed</h1>
        <p className="muted">You were logged out on every device. Log in with your new password.</p>
        <Link className="btn block" href="/login">Log in</Link>
      </> : bad ? <>
        <h1>This reset link doesn&apos;t work</h1>
        <p className="muted">It has expired or was already used. Ask support for a new one.</p>
        <SupportCard />
        <Link className="btn ghost block" href="/login">Back to log in</Link>
      </> : <>
        <div className="stack" style={{ gap: 6 }}><h1>Set a new password</h1><p className="muted">This link works once. After saving, you&apos;ll be logged out everywhere.</p></div>
        <form className="form" onSubmit={submit} noValidate>
          <div className="field"><label htmlFor="r-pw">New password</label><input className="inp" id="r-pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /><span className="hint">At least 8 characters.</span></div>
          <div className="field"><label htmlFor="r-pw2">Type it again</label><input className="inp" id="r-pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></div>
          {err && <p className="err" role="alert">{err}</p>}
          <button className="btn block" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save new password'}</button>
        </form>
      </>}
    </AuthLayout>
  );
}
