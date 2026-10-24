// Task text of mandates created on this page, so the approval queue can show it.
// StreamEvent has no task field, and there is no GET /mandates yet.
const tasks = new Map<string, string>();

export function rememberMandateTask(mandateId: string, task: string) {
  tasks.set(mandateId, task);
}

export function mandateTask(mandateId: string): string | undefined {
  return tasks.get(mandateId);
}
