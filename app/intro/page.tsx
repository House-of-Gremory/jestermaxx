import type { Metadata } from 'next';
import { Suspense } from 'react';
import IntroBuilder from '../components/intro-builder';

export const metadata: Metadata = {
  title: 'Build Your Intro',
  description: 'Create a quick intro reel before entering the Jester Maxing arena.',
};

export default function IntroPage() {
  return (
    <Suspense fallback={null}>
      <IntroBuilder />
    </Suspense>
  );
}
