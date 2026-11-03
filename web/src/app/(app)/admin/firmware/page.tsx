'use client';

// Placeholder until the admin screens are built (stage 3). Permission: firmware.view.
import { RequireStaff } from '@/components/Shell';
import { Placeholder } from '@/components/ui';

export default function FirmwareOtaPage() {
  return (
    <RequireStaff perm="firmware.view">
      <Placeholder title="Firmware & OTA" stage="stage 3" items={['Versions: version, channel, uploaded, size, sha256, devices, notes', 'Upload a .bin (firmware.upload)', 'Rollouts with live progress; start / pause (firmware.rollout)']} />
    </RequireStaff>
  );
}
