'use client';

// Placeholder until the admin screens are built (stage 3). Permission: devices.register.
import { RequireStaff } from '@/components/Shell';
import { Placeholder } from '@/components/ui';

export default function RegisterByUsbPage() {
  return (
    <RequireStaff perm="devices.register">
      <Placeholder title="Register by USB" stage="stage 3" items={['Connect the board by USB (Chrome/Edge, Web Serial + esptool-js) to read MAC and chip', 'Register → serial, claim code, QR sticker to print', 'Devices registered today']} />
    </RequireStaff>
  );
}
