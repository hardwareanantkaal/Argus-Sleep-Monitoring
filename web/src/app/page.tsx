'use client';

// "/" just sends you to your home screen (or to log in).
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/components/Providers';
import { homeFor } from '@/components/Shell';
import { Loading } from '@/components/ui';

export default function Home() {
  const { user } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (user === null) router.replace('/login');
    else if (user) router.replace(homeFor(user));
  }, [user, router]);
  return <Loading />;
}
