import type { Metadata } from 'next';
import VideoCall from '../components/video-call';

export const metadata: Metadata = {
  title: 'Arena',
  description: 'Enter a live 1v1 video duel and try to make a stranger laugh.',
  robots: {
    index: false,
    follow: true,
  },
};

export default function ArenaPage() {
  return <VideoCall />;
}
