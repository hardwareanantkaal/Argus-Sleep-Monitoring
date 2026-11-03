'use client';

// Placeholder until the admin screens are built (stage 3). Permission: customers.view.
import { RequireStaff } from '@/components/Shell';
import { Placeholder } from '@/components/ui';

export default function CustomerDetailPage() {
  return (
    <RequireStaff perm="customers.view">
      <Placeholder title="Customer detail" stage="stage 3" back={['/admin/customers', 'Customers']} items={['Customer (with country), their devices (with time zone), family members', 'Create a one-time password reset link to send (customers.edit)', 'Disable / enable the account with a reason (customers.edit)']} />
    </RequireStaff>
  );
}
