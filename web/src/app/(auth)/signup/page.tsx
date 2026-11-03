'use client';

// Sign-up in 3 steps: account → add first sensor (or skip) → placement tips.
// The phone is not verified in v1 (no SMS). Country is pre-filled from the phone code.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AuthLayout, useNextParam } from '@/components/AuthLayout';
import { ClaimFlow } from '@/components/ClaimFlow';
import { Icon } from '@/components/Icon';
import { useAuth } from '@/components/Providers';
import { homeFor } from '@/components/Shell';
import { PhoneInput, PH } from '@/components/ui';
import { errText } from '@/lib/api';
import { COUNTRIES, toE164 } from '@/lib/format';

export default function SignupPage() {
  const { user, register } = useAuth();
  const router = useRouter();
  const next = useNextParam();
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [code, setCode] = useState('+91');
  const [local, setLocal] = useState('');
  const [country, setCountry] = useState('IN');
  const [countryTouched, setCountryTouched] = useState(false);
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [field, setField] = useState('');
  const [busy, setBusy] = useState(false);

  // Already logged in and not in the middle of sign-up: nothing to do here.
  useEffect(() => { if (user && step === 1 && !busy) router.replace(next || homeFor(user)); }, [user, step, busy, next, router]);

  // Phone code → country, until the person picks a country themselves.
  useEffect(() => {
    if (countryTouched) return;
    const c = COUNTRIES.find((x) => x.code === code);
    if (c) setCountry(c.iso);
  }, [code, countryTouched]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(''); setField('');
    if (!name.trim()) { setField('fullName'); return setErr('Enter your name'); }
    if (local.replace(/\D/g, '').length < 6) { setField('phone'); return setErr('Enter your phone number'); }
    if (pw.length < 8) { setField('password'); return setErr('Password must be at least 8 characters'); }
    setBusy(true);
    try {
      await register({ fullName: name.trim(), phone: toE164(code, local), country, password: pw });
      if (next) return router.replace(next); // back to "Accept invite"
      setStep(2);
    } catch (e2) {
      setErr(errText(e2));
      setField((e2 as { field?: string }).field || '');
    } finally { setBusy(false); }
  };

  return (
    <AuthLayout>
      <div className="steps" aria-label={`Step ${step} of 3`}><i className="on" /><i className={step > 1 ? 'on' : ''} /><i className={step > 2 ? 'on' : ''} /></div>
      {step === 1 && <>
        <div className="stack" style={{ gap: 6 }}><span className="label">Step 1 of 3</span><h1>Create your account</h1></div>
        {next?.startsWith('/invite/') && <div className="banner ok">After this you&apos;ll go straight back to your invite.</div>}
        <form className="form" onSubmit={submit} noValidate>
          <div className="field"><label htmlFor="s-name">Your name</label><input className="inp" id="s-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={field === 'fullName'} /></div>
          <div className="field"><label htmlFor="s-ph">Phone number</label><PhoneInput id="s-ph" code={code} setCode={setCode} local={local} setLocal={setLocal} /><span className="hint">This is your login. We don&apos;t send SMS.</span></div>
          <div className="field">
            <label htmlFor="s-country">Country</label>
            <select className="inp" id="s-country" value={country} onChange={(e) => { setCountry(e.target.value); setCountryTouched(true); }}>
              {COUNTRIES.map((c) => <option key={c.iso} value={c.iso}>{c.name}</option>)}
            </select>
            <span className="hint">Filled in from the phone code. Change it if you live somewhere else.</span>
          </div>
          <div className="field"><label htmlFor="s-pw">Password</label><input className="inp" id="s-pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} aria-invalid={field === 'password'} /><span className="hint">At least 8 characters.</span></div>
          {err && <p className="err" role="alert">{err}</p>}
          <button className="btn block" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Continue'}</button>
        </form>
        <p className="small muted">Already have an account? <Link href={next ? `/login?next=${encodeURIComponent(next)}` : '/login'}>Log in</Link></p>
      </>}
      {step === 2 && <>
        <div className="stack" style={{ gap: 6 }}><span className="label">Step 2 of 3</span><h1>Add your first sensor</h1><p className="muted">Find the QR sticker on the back of the sensor.</p></div>
        <ClaimFlow onDone={() => setStep(3)} onSkip={() => setStep(3)} />
      </>}
      {step === 3 && <>
        <div className="stack" style={{ gap: 6 }}><span className="label">Step 3 of 3</span><h1>Place the sensor</h1></div>
        <div className="card stack">
          <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}><Icon name="bed" size={22} /><p className="small">Put it on the bedside table at chest height, facing the person, within 1–2 m. <PH /></p></div>
          <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}><Icon name="wifi" size={22} /><p className="small">Keep it plugged in and on your home Wi-Fi.</p></div>
          <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}><Icon name="moon" size={22} /><p className="small">Your first sleep summary appears the morning after the first night.</p></div>
        </div>
        <button className="btn block" onClick={() => router.replace('/devices')}>Go to my devices</button>
      </>}
    </AuthLayout>
  );
}
