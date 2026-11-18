'use client';

import { useParams } from 'next/navigation';
import Navbar from '../../../../components/layout/Navbar';
import MeetingList from '../../../../components/meetings/MeetingList';

export default function ProjectMeetingsPage() {
  const params = useParams();
  const projectId = params?.projectId as string;
  return (
    <>
      <Navbar />
      <MeetingList projectId={projectId} />
    </>
  );
}
