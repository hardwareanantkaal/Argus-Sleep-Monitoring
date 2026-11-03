'use client';

// Placeholder until the admin screens are built (stage 3). Permission: any staff.
import { RequireStaff } from '@/components/Shell';
import { Placeholder } from '@/components/ui';

export default function DashboardPage() {
  return (
    <RequireStaff>
      <Placeholder title="Dashboard" stage="stage 3" items={['Counts: registered, online, offline, not claimed, customers, running rollouts', 'Devices online per hour (24 h)', 'Devices per firmware version', 'Last 5 audit entries (with audit.view)']} />
    </RequireStaff>
  );
}
