'use client';

// Vendor groups (API.md 15.3): a simple list of names, e.g. "Ward 3". Deleting one leaves its devices with no group.

import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/Providers';
import { RequireVendor } from '@/components/Shell';
import { Async, Head, useApi } from '@/components/ui';
import { del, errText, patch, post } from '@/lib/api';
import type { VendorGroup } from '@/lib/types';

export default function VendorGroupsPage() {
  return <RequireVendor><Inner /></RequireVendor>;
}

function Inner() {
  const toast = useToast();
  const q = useApi<{ items: VendorGroup[] }>('/vendor/groups');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState<{ id: string; name: string } | null>(null);

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (!name.trim()) return setErr('Name the group');
    try { await post('/vendor/groups', { name: name.trim() }); toast('Group added'); setName(''); q.reload(); } catch (e2) { setErr(errText(e2)); }
  };
  const rename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!edit || !edit.name.trim()) return;
    try { await patch(`/vendor/groups/${edit.id}`, { name: edit.name.trim() }); toast('Group renamed'); setEdit(null); q.reload(); } catch (e2) { toast(errText(e2)); }
  };
  const remove = async (g: VendorGroup) => {
    if (!confirm(`Delete “${g.name}”? ${g.deviceCount ? `Its ${g.deviceCount} device${g.deviceCount === 1 ? '' : 's'} will have no group.` : ''}`)) return;
    try { await del(`/vendor/groups/${g.id}`); toast('Group deleted'); q.reload(); } catch (e) { toast(errText(e)); }
  };

  return (
    <div className="wrap narrow">
      <Head title="Groups" sub="Simple names to sort your devices, e.g. “Ward 3” or “Floor 1”." />
      <div className="card">
        <form className="row" style={{ flexWrap: 'nowrap' }} onSubmit={add}>
          <input className="inp" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="New group name" aria-label="New group name" style={{ minWidth: 0 }} />
          <button className="btn" type="submit"><Icon name="plus" /> Add</button>
        </form>
        {err && <p className="err" role="alert" style={{ marginTop: 10 }}>{err}</p>}
      </div>
      <Async q={q}>{(r) => r.items.length ? (
        <div className="card">
          {r.items.map((g) => (
            <div key={g.id} className="between" style={{ padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
              {edit?.id === g.id ? (
                <form className="row" style={{ flex: 1, flexWrap: 'nowrap' }} onSubmit={rename}>
                  <input className="inp sm" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={60} autoFocus aria-label="Group name" style={{ minWidth: 0 }} />
                  <button className="btn sm" type="submit">Save</button>
                  <button className="btn ghost sm" type="button" onClick={() => setEdit(null)}>Cancel</button>
                </form>
              ) : <>
                <div className="stack" style={{ gap: 0 }}><b className="small">{g.name}</b><span className="xs muted">{g.deviceCount} device{g.deviceCount === 1 ? '' : 's'}</span></div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn ghost sm" onClick={() => setEdit({ id: g.id, name: g.name })}>Rename</button>
                  <button className="btn danger sm" onClick={() => remove(g)}>Delete</button>
                </div>
              </>}
            </div>
          ))}
        </div>
      ) : <div className="card empty"><Icon name="list" size={30} /><h2>No groups yet</h2><p>Add one above, then pick it on the Devices screen.</p></div>}</Async>
    </div>
  );
}
