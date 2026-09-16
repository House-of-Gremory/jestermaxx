import type { Metadata } from 'next';
import Landing from './components/landing';
import { SITE_DESCRIPTION, SITE_NAME } from '@/lib/site-config';

export const metadata: Metadata = {
  title: `${SITE_NAME} - Play a Stranger in a Try-Not-To-Laugh Duel`,
  description: SITE_DESCRIPTION,
};

export default function HomePage() {
  return <Landing />;
}
