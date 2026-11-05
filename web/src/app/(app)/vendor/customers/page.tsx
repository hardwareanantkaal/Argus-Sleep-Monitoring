'use client';

// Vendor customers (API.md 15.2b, v2): everyone who bought one of my vendor's sensors (scanned the
// sticker of a sensor in our stock), with the sensors each one owns. One customer can have many.

import { useState } from 'react';
import { RequireVendor } from '@/components/Shell';
import { Async, Head, useApi } from '@/components/ui';
import { CustomerList } from '@/components/vendor';
import { useAuth } from '@/components/Providers';
import type { VendorCustomer } from '@/lib/types';

export default function VendorCustomersPage() {
  return <RequireVendor><Inner /></RequireVendor>;
}

function Inner() {
  const { user } = useAuth();
  const q = useApi<{ items: VendorCustomer[] }>('/vendor/customers');
  const [term, setTerm] = useState('');
  const t = term.trim().toLowerCase();
  const items = (q.data?.items || []).filter((c) => !t || `${c.fullName} ${c.phone} ${c.devices.map((d) => `${d.serial} ${d.name}`).join(' ')}`.toLowerCase().includes(t));
  const sensors = (q.data?.items || []).reduce((a, c) => a + c.devices.length, 0);
  return (
    <div className="wrap">
      <Head title="Customers" sub={q.data ? `${user?.vendor?.name} · ${q.data.items.length} customer${q.data.items.length === 1 ? '' : 's'} · ${sensors} sensor${sensors === 1 ? '' : 's'} sold` : undefined} />
      <input className="inp" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search name, phone or serial" aria-label="Search customers" style={{ maxWidth: 340 }} />
      <Async q={q}>{() => <div className="card"><CustomerList items={items} deviceHref={(id) => `/devices/${id}`} /></div>}</Async>
    </div>
  );
}
