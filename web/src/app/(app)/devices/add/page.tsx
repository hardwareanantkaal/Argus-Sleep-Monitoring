'use client';

import { useRouter } from 'next/navigation';
import { ClaimFlow } from '@/components/ClaimFlow';
import { useToast } from '@/components/Providers';
import { Head } from '@/components/ui';

export default function AddDevicePage() {
  const router = useRouter();
  const toast = useToast();
  return (
    <div className="wrap narrow">
      <Head title="Add a device" sub="Every sensor has a QR sticker with its serial and claim code." back={['/devices', 'My devices']} />
      <ClaimFlow onDone={(d) => { toast(`${d.name} added`); router.replace(`/devices/${d.id}`); }} />
    </div>
  );
}
