import AgentRestrictions from './agent-restrictions';
import ApprovalQueue from './approval-queue';
import EventFeed from './event-feed';
import LogoutButton from './logout-button';
import MandateForm from './mandate-form';
import PaymentsPanel from './payments-panel';
import StatsHeader from './stats-header';
import WorkerLab from './worker-lab';

// Show actionable restriction state; the historical score graph remains hidden.
export default function Home() {
  return (
    <main className="p-6">
      <header className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Raijin Gateway</h1>
        <LogoutButton />
      </header>
      <StatsHeader />
      <MandateForm />
      <WorkerLab />
      <AgentRestrictions />
      <ApprovalQueue />
      <PaymentsPanel />
      <EventFeed />
    </main>
  );
}
