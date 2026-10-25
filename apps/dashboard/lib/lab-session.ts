export type LabMandate = { id: string; token: string; task: string };

const KEY = 'apf-lab-mandates';
export const LAB_MANDATES_EVENT = 'apf-lab-mandates';

export function loadLabMandates(): LabMandate[] {
  if (typeof sessionStorage === 'undefined') return [];
  try {
    const parsed = JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as LabMandate[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        typeof item?.id === 'string' &&
        typeof item.token === 'string' &&
        typeof item.task === 'string',
    );
  } catch {
    return [];
  }
}

export function rememberLabMandate(mandate: LabMandate) {
  const next = [mandate, ...loadLabMandates().filter((item) => item.id !== mandate.id)].slice(0, 8);
  sessionStorage.setItem(KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(LAB_MANDATES_EVENT));
}
