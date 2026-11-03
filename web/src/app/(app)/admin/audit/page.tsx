'use client';

// Placeholder until the admin screens are built (stage 3). Permission: audit.view.
import { RequireStaff } from '@/components/Shell';
import { Placeholder } from '@/components/ui';

export default function AuditLogPage() {
  return (
    <RequireStaff perm="audit.view">
      <Placeholder title="Audit log" stage="stage 3" items={['Every write by staff or customers: time, who, action, target, detail', 'Search and action-type filter (read-only)']} />
    </RequireStaff>
  );
}
