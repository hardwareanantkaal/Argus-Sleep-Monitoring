'use client';

// Account (Profile): name, country, password, theme, log out (API.md 2.1–2.3, 1.4).

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useAuth, useTheme, useToast } from '@/components/Providers';
import { Head } from '@/components/ui';
import { errText, patch, post } from '@/lib/api';
import { COUNTRIES, initials, prettyPhone } from '@/lib/format';
import type { User } from '@/lib/types';

export default function AccountPage() {
  const { user, setUser, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const toast = useToast();
  const router = useRouter();
  const [name, setName] = useState(user?.fullName || '');
  const [country, setCountry] = useState(user?.country || 'IN');
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [err, setErr] = useState('');
  const [pwErr, setPwErr] = useState('');
  if (!user) return null;

  const saveDetails = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (!name.trim()) return setErr('Enter your name');
    try { setUser(await patch<User>('/me', { fullName: name.trim(), country })); toast('Saved'); } catch (e2) { setErr(errText(e2)); }
  };
  const changePw = async (e: React.FormEvent) => {
    e.preventDefault(); setPwErr('');
    if (newPw.length < 8) return setPwErr('New password must be at least 8 characters');
    try { await post('/me/password', { currentPassword: oldPw, newPassword: newPw }); setOldPw(''); setNewPw(''); toast('Password changed. Other devices were logged out.'); } catch (e2) { setPwErr(errText(e2)); }
  };

  return (
    <div className="wrap narrow">
      <Head title="Account" />
      <div className="card"><div className="row" style={{ gap: 14 }}>
        <div className="avatar" style={{ width: 52, height: 52, fontSize: 18 }}>{initials(user.fullName)}</div>
        <div className="stack" style={{ gap: 2 }}><h2>{user.fullName}</h2><span className="small muted">{prettyPhone(user.phone)}{user.role ? ` · ${user.role.name}` : ''}</span></div>
      </div></div>
      <div className="card"><h2 style={{ marginBottom: 14 }}>Your details</h2>
        <form className="form" onSubmit={saveDetails}>
          <div className="field"><label htmlFor="pf-name">Name</label><input className="inp" id="pf-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label htmlFor="pf-ph">Phone number</label><input className="inp" id="pf-ph" value={prettyPhone(user.phone)} disabled /><span className="hint">Your phone number is your login. Contact support to change it.</span></div>
          <div className="field"><label htmlFor="pf-country">Country</label>
            <select className="inp" id="pf-country" value={country} onChange={(e) => setCountry(e.target.value)}>{COUNTRIES.map((c) => <option key={c.iso} value={c.iso}>{c.name}</option>)}</select></div>
          {err && <p className="err" role="alert">{err}</p>}
          <button className="btn" type="submit" style={{ alignSelf: 'flex-start' }}>Save</button>
        </form>
      </div>
      <div className="card"><h2 style={{ marginBottom: 14 }}>Password</h2>
        <form className="form" onSubmit={changePw}>
          <div className="fields2">
            <div className="field"><label htmlFor="pf-old">Current password</label><input className="inp" type="password" id="pf-old" autoComplete="current-password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} /></div>
            <div className="field"><label htmlFor="pf-new">New password</label><input className="inp" type="password" id="pf-new" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} /></div>
          </div>
          {pwErr && <p className="err" role="alert">{pwErr}</p>}
          <button className="btn ghost" type="submit" style={{ alignSelf: 'flex-start' }}>Change password</button>
        </form>
      </div>
      <div className="card"><h2 style={{ marginBottom: 6 }}>Appearance</h2>
        <label className="tog"><span className="t"><span>Dark theme</span><span className="xs muted">Easier on the eyes at night</span></span>
          <input type="checkbox" className="sw" checked={theme === 'dark'} onChange={(e) => setTheme(e.target.checked ? 'dark' : 'light')} /></label>
      </div>
      <div className="row">
        <button className="btn ghost" onClick={async () => { await logout(); router.replace('/login'); }}><Icon name="out" /> Log out</button>
      </div>
      <p className="xs muted">Leaving shared devices and deleting the account come in a later stage.</p>
    </div>
  );
}
