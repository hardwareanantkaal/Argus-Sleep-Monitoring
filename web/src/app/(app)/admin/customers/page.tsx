'use client';

// Placeholder until the admin screens are built (stage 3). Permission: customers.view.
import { RequireStaff } from '@/components/Shell';
import { Placeholder } from '@/components/ui';

export default function CustomersPage() {
  return (
    <RequireStaff perm="customers.view">
      <Placeholder title="Customers" stage="stage 3" items={['Paged list with search, country filter and device time-zone filter', 'name, phone, country, device time zones, devices, family, joined, last active, status']} />
    </RequireStaff>
  );
}
