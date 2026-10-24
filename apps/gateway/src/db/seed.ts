// Demo data: one tenant, the research and bulk roles, three agents, and the catalog.
// Safe to run again: rows are upserted by fixed ids, and agent trust is left alone.
import { ONE_USDC, TRUST_THRESHOLDS, type Catalog } from '@apf/contracts';
import type { Clock } from '../clock.js';
import type { Db } from './client.js';
import { agents, endpoints, merchants, roles, standingGrants, tenants } from './schema.js';

export const DEMO = {
  tenantId: 'tnt_demo',
  /** Design.md: TENANT_DAILY default $20.00. */
  tenantDailyCap: 20 * ONE_USDC,
  roles: { research: 'rol_research', bulk: 'rol_bulk' },
  agents: { pricing: 'agt_pricing', logistics: 'agt_logistics', bulk: 'agt_bulk' },
  /** Standing grants have no contract id prefix of their own; they use grt_ with a fixed name. */
  standingGrantId: (role: string, endpointId: string) =>
    `grt_standing_${role}_${endpointId.replace(/^end_/, '')}`,
} as const;

const RESEARCH = {
  id: DEMO.roles.research,
  name: 'research',
  policy_text:
    'Research agents may buy market data needed for the assigned report. No bulk datasets, subscriptions or unrelated data.',
  per_call_cap: ONE_USDC,
  velocity_per_min: 20,
  baseline_trust: 70,
  grant_trust_threshold: TRUST_THRESHOLDS.grants,
};

const BULK = {
  id: DEMO.roles.bulk,
  name: 'bulk',
  policy_text:
    'Bulk agents may buy routine data in volume from merchants selected for the mandate. No subscriptions or unrelated data.',
  per_call_cap: ONE_USDC,
  velocity_per_min: 120,
  baseline_trust: 70,
  grant_trust_threshold: TRUST_THRESHOLDS.grants,
};

const ROLES = [RESEARCH, BULK];

const AGENTS = [
  { id: DEMO.agents.pricing, role: RESEARCH, name: 'Pricing researcher' },
  { id: DEMO.agents.logistics, role: RESEARCH, name: 'Logistics analyst' },
  { id: DEMO.agents.bulk, role: BULK, name: 'Bulk loader' },
];

/** Seeds everything in one transaction; any error (such as an unknown role) writes nothing. */
export function seedDatabase(db: Db, catalog: Catalog, clock: Clock): void {
  const { orm } = db;
  const now = clock.now();
  const roleIdByName = new Map(ROLES.map((role) => [role.name, role.id]));

  db.sqlite.transaction(() => {
    orm
      .insert(tenants)
      .values({
        id: DEMO.tenantId,
        name: 'Demo Co',
        daily_cap: DEMO.tenantDailyCap,
        created_at: now,
      })
      .onConflictDoUpdate({ target: tenants.id, set: { daily_cap: DEMO.tenantDailyCap } })
      .run();

    for (const { id, ...values } of ROLES) {
      orm
        .insert(roles)
        .values({ id, tenant_id: DEMO.tenantId, ...values })
        .onConflictDoUpdate({ target: roles.id, set: values })
        .run();
    }

    for (const { id, role, name } of AGENTS) {
      orm
        .insert(agents)
        .values({
          id,
          name,
          role_id: role.id,
          tenant_id: DEMO.tenantId,
          trust: role.baseline_trust,
        })
        // Trust is left alone on a rerun: it is the agent's history, not seed data.
        .onConflictDoUpdate({ target: agents.id, set: { name, role_id: role.id } })
        .run();
    }

    for (const merchant of catalog.merchants) {
      const values = {
        name: merchant.name,
        origin: merchant.origin,
        payee: merchant.payee,
        category: merchant.category,
        description: merchant.description,
      };
      orm
        .insert(merchants)
        .values({ id: merchant.id, tenant_id: DEMO.tenantId, ...values })
        .onConflictDoUpdate({ target: merchants.id, set: values })
        .run();

      for (const endpoint of merchant.endpoints) {
        const endpointValues = {
          merchant_id: merchant.id,
          method: endpoint.method,
          path: endpoint.path,
          category: endpoint.category,
          description: endpoint.description,
          params_json: JSON.stringify(endpoint.params),
        };
        orm
          .insert(endpoints)
          .values({ id: endpoint.id, ...endpointValues })
          .onConflictDoUpdate({ target: endpoints.id, set: endpointValues })
          .run();
      }
    }

    for (const grant of catalog.standing_grants) {
      const roleId = roleIdByName.get(grant.role);
      if (roleId === undefined) {
        throw new Error(`Catalog standing grant names unknown role "${grant.role}"`);
      }
      const values = {
        role_id: roleId,
        endpoint_id: grant.endpoint_id,
        max_per_call: grant.max_per_call,
        daily_total: grant.daily_total,
      };
      orm
        .insert(standingGrants)
        .values({ id: DEMO.standingGrantId(grant.role, grant.endpoint_id), ...values })
        .onConflictDoUpdate({ target: standingGrants.id, set: values })
        .run();
    }
  })();
}
