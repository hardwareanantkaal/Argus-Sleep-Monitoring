'use client';

// Placeholder until the admin screens are built (stage 3). Permission: team.manage.
import { RequireStaff } from '@/components/Shell';
import { Placeholder } from '@/components/ui';

export default function TeamPermissionsPage() {
  return (
    <RequireStaff perm="team.manage">
      <Placeholder title="Team & permissions" stage="stage 3" items={['Members and their roles', 'Invite by link: label + role → link to copy and send', 'Roles and their permission switches (Owner is locked)']} />
    </RequireStaff>
  );
}
