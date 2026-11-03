'use client';

// Placeholder until the admin screens are built (stage 3). Permission: devices.view.
import { RequireStaff } from '@/components/Shell';
import { Placeholder } from '@/components/ui';

export default function DeviceDetailPage() {
  return (
    <RequireStaff perm="devices.view">
      <Placeholder title="Device detail" stage="stage 3" back={['/admin/devices', 'Devices']} items={['Hardware: MAC, chip, radar, firmware, registered', 'Connection: online, last seen, time zone, night cut-off, IP, signal, uptime', 'Owner and shares', 'Commands reboot / config_mode / ota_check / logs (devices.command) and their history', 'Latest uploaded logs']} />
    </RequireStaff>
  );
}
