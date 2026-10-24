import EventFeed from "./event-feed";

export default function Home() {
  return (
    <main className="p-6">
      <h1 className="mb-4 text-xl font-semibold">Agent Payment Firewall</h1>
      <EventFeed />
    </main>
  );
}