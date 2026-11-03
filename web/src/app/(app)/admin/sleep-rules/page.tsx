'use client';

// Placeholder until the admin screens are built (stage 3). Permission: platform.settings.
import { RequireStaff } from '@/components/Shell';
import { Placeholder } from '@/components/ui';

export default function SleepRulesPage() {
  return (
    <RequireStaff perm="platform.settings">
      <Placeholder title="Sleep rules" stage="stage 3" items={['Join sessions less than N minutes apart (default 30)', 'Hide sessions shorter than N minutes (default 25)', 'Default “a new night starts at” for newly claimed devices (12:00)']} />
    </RequireStaff>
  );
}
