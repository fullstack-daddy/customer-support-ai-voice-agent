import { currentAdmin } from '@/lib/admin.server';
import AdminNav from './AdminNav';
import Toasts from '@/components/Toast';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await currentAdmin();

  // The login page renders inside this layout too; it has no session yet,
  // so the chrome is suppressed rather than showing an empty nav.
  if (!admin) return <>{children}<Toasts /></>;

  return (
    <div className="shell">
      <AdminNav adminName={admin.name} adminEmail={admin.email} />
      {children}
      <Toasts />
    </div>
  );
}
