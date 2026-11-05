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
      {/* v2.1: a sensor added to vendor stock has no name yet; go back to the vendor's stock list */}
      <ClaimFlow onDone={(d) => {
        if (d.access === 'vendor' && d.stage === 'stock') { toast(`${d.serial} added to stock`); router.replace('/vendor'); return; }
        toast(`${d.name} added`); router.replace(`/devices/${d.id}`);
      }} />
    </div>
  );
}
