'use client';

// Placeholder until the admin screens are built (stage 3). Permission: devices.view.
import { RequireStaff } from '@/components/Shell';
import { Placeholder } from '@/components/ui';

export default function DevicesPage() {
  return (
    <RequireStaff perm="devices.view">
      <Placeholder title="Devices" stage="stage 3" items={['Paged list with search (serial, MAC, name, owner) and status filter', 'serial, name, owner, status, time zone, firmware, chip, last seen', 'Live online/offline (device:status)']} />
    </RequireStaff>
  );
}
