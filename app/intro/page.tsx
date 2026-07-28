import { Suspense } from 'react';
import IntroBuilder from '../components/intro-builder';

export default function IntroPage() {
  return (
    <Suspense fallback={null}>
      <IntroBuilder />
    </Suspense>
  );
}
