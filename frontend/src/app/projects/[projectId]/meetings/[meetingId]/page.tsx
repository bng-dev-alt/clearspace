'use client';

import { useParams } from 'next/navigation';
import Navbar from '../../../../../components/layout/Navbar';
import MeetingDetail from '../../../../../components/meetings/MeetingDetail';

export default function MeetingDetailPage() {
  const params = useParams();
  return (
    <>
      <Navbar />
      <MeetingDetail projectId={params?.projectId as string} meetingId={params?.meetingId as string} />
    </>
  );
}
