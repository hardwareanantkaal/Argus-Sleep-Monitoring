'use client';

// /history → the first sensor I can see history for.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Icon } from '@/components/Icon';
import { Async, Head, useApi } from '@/components/ui';
import type { DeviceCard } from '@/lib/types';

export default function HistoryIndex() {
  const q = useApi<{ items: DeviceCard[] }>('/devices');
  const router = useRouter();
  const first = q.data?.items.find((d) => d.myPermissions.includes('history.view'));
  useEffect(() => { if (first) router.replace(`/history/${first.id}`); }, [first, router]);
  return (
    <div className="wrap">
      <Head title="Sleep history" />
      <Async q={q}>{() => first ? null : (
        <div className="card empty"><Icon name="moon" size={30} /><h2>No sleep history to show</h2>
          <p>Add a sensor, or ask the owner of a shared sensor to turn on “See sleep history” for you.</p>
          <Link className="btn" href="/devices/add">Add device</Link></div>
      )}</Async>
    </div>
  );
}
