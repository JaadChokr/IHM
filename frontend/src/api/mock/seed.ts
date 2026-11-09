import type { AuditEvent, RuleInput, RuleVersion, TestRecord, User } from '../types';
import { queryHash } from '../../lib/sql';

export interface MockRule {
  ruleId: string;
  versions: RuleVersion[];
  /**
   * Exécutions Airflow simulées (table rule_runs) : date du premier run de chaque version, et date
   * du dernier run quand le DAG s'est arrêté. C'est d'ici que se déduisent les statuts.
   */
  productionSince: Record<number, string>;
  /** Versions déjà envoyées au prestataire, même si une version plus récente les a remplacées depuis. */
  wasSent?: number[];
  productionUntil: Record<number, string>;
  /** Comportement simulé des indicateurs. */
  profile?: { dailyVolume: number; processingRate: number; precision: number; brokenSinceDays?: number };
  /** Variations par version (ex. une v2 au seuil plus strict : moins de volume, plus de précision). */
  versionProfiles?: Record<number, { dailyVolume?: number; precision?: number }>;
}

/** Brouillon personnel stocké (comme la table `drafts`) : visible de son seul auteur. */
export interface MockDraft extends RuleInput {
  id: string;
  matricule: string;
  ruleId: string;
  baseVersion?: number;
  createdAt: string;
  updatedAt: string;
}

export interface MockDb {
  schema: number;
  users: User[];
  rules: MockRule[];
  drafts: MockDraft[];
  tests: TestRecord[];
  audit: AuditEvent[];
}

export const SCHEMA_VERSION = 15;

/** Marqueur : la version a tourné ; v() le remplace par le DAG de sa fréquence. */
const dag = 'dag';

const daysAgo = (n: number, h = 10) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(h, 0, 0, 0);
  return d.toISOString();
};

const USERS: User[] = [
  { matricule: '104233', firstName: 'Camille', lastName: 'Martin' },
  { matricule: '118870', firstName: 'Sacha', lastName: 'Bernard' },
  { matricule: '120415', firstName: 'Noa', lastName: 'Petit' },
];
const name = (m: string) => {
  const u = USERS.find((x) => x.matricule === m);
  return u ? `${u.firstName} ${u.lastName}` : 'Équipe data (base)';
};

interface Def {
  id: string;
  owner: string;
  name: string;
  description: string;
  fraudTypology: string;
  criticality: RuleVersion['criticality'];
  schedule: RuleVersion['schedule'];
  sql: string;
}

function content(def: Def): RuleInput {
  return {
    name: def.name,
    description: def.description,
    fraudTypology: def.fraudTypology,
    criticality: def.criticality,
    schedule: def.schedule,
    sqlQuery: def.sql,
  };
}

/** Version soumise (toutes les versions stockées le sont ; le statut affiché se déduit des runs). */
function v(def: Def, version: number, created: number, extra: Partial<RuleVersion> = {}): RuleVersion {
  return {
    ruleId: def.id,
    version,
    name: def.name,
    description: def.description,
    fraudTypology: def.fraudTypology,
    criticality: def.criticality,
    schedule: def.schedule,
    sqlQuery: def.sql,
    status: 'SUBMITTED',
    ownerMatricule: def.owner,
    ownerName: name(def.owner),
    submittedBy: def.owner,
    submittedByName: name(def.owner),
    createdAt: daysAgo(created),
    updatedAt: daysAgo(Math.max(0, created - 1)),
    submittedAt: daysAgo(Math.max(0, created - 1)),
    ...extra,
    // Un DAG par fréquence : toutes les règles quotidiennes tournent dans fraud_rules_daily, etc.
    ...(extra.airflowDagId ? { airflowDagId: `fraud_rules_${def.schedule.toLowerCase()}` } : {}),
  };
}

const R1: Def = {
  id: '7f3c2a10-5b1e-4c8a-9d21-0a1b2c3d4e01',
  owner: '104233',
  name: 'Compte récent et panier élevé',
  description:
    "Commandes d'un montant élevé passées par un compte créé il y a moins de 24 h. Scénario typique d'ouverture de compte avec moyen de paiement volé.",
  fraudTypology: 'Fraude au moyen de paiement',
  criticality: 'HIGH',
  schedule: 'DAILY',
  sql: `SELECT
  o.order_id,
  o.amount_eur,
  c.account_created_at
FROM \`sales.orders\` o
JOIN \`sales.customers\` c USING (customer_id)
WHERE o.order_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
  AND o.amount_eur >= 500
  AND TIMESTAMP_DIFF(o.created_at, c.account_created_at, HOUR) < 24`,
};
const R1_V1_SQL = R1.sql.replace('>= 500', '>= 300');
// v3 : on écarte les comptes dont l'e-mail a été vérifié, sources de faux positifs.
const R1_V3_SQL = R1.sql + '\n  AND NOT c.email_verified';

const R2: Def = {
  id: '7f3c2a10-5b1e-4c8a-9d21-0a1b2c3d4e02',
  owner: '118870',
  name: 'Livraison hors pays de facturation',
  description:
    "Commandes livrées dans un pays différent de celui de l'adresse de facturation, au-dessus d'un seuil de montant.",
  fraudTypology: 'Triangulation / revente',
  criticality: 'MEDIUM',
  schedule: 'DAILY',
  sql: `SELECT
  o.order_id,
  o.amount_eur,
  d.country AS shipping_country,
  a.country AS billing_country
FROM \`sales.orders\` o
JOIN \`sales.deliveries\` d USING (order_id)
JOIN \`sales.addresses\` a ON a.address_id = o.billing_address_id
WHERE o.order_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
  AND d.country != a.country
  AND o.amount_eur >= 150`,
};

// v2 : seuil abaissé à 100 €, départements d'outre-mer exclus (adresses de facturation métropolitaines légitimes).
const R2_V2_SQL = R2.sql.replace('>= 150', '>= 100') + `\n  AND a.country NOT IN ('GP', 'MQ', 'GF', 'RE', 'YT')`;

const R3: Def = {
  id: '7f3c2a10-5b1e-4c8a-9d21-0a1b2c3d4e03',
  owner: '104233',
  name: 'Tentatives de paiement multiples',
  description: 'Commandes ayant nécessité de nombreuses tentatives de paiement avant acceptation (test de cartes).',
  fraudTypology: 'Fraude au moyen de paiement',
  criticality: 'MEDIUM',
  schedule: 'HOURLY',
  sql: `SELECT
  p.order_id,
  p.attempt_count,
  p.card_bin
FROM \`sales.payments\` p
JOIN \`sales.orders\` o USING (order_id)
WHERE o.order_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
  AND p.attempt_count >= 3`,
};
const R3_V2_SQL = R3.sql.replace('>= 3', '>= 5') + `\n  AND p.status = 'ACCEPTED'`;

const R4: Def = {
  id: '7f3c2a10-5b1e-4c8a-9d21-0a1b2c3d4e04',
  owner: '120415',
  name: "Changement d'e-mail puis commande",
  description: "Commande passée moins de 2 h après un changement d'adresse e-mail du compte (prise de contrôle).",
  fraudTypology: 'Prise de contrôle de compte',
  criticality: 'HIGH',
  schedule: 'HOURLY',
  sql: `SELECT
  o.order_id,
  c.email_changed_at,
  o.created_at
FROM \`sales.orders\` o
JOIN \`sales.customers\` c USING (customer_id)
WHERE o.order_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
  AND TIMESTAMP_DIFF(o.created_at, c.email_changed_at, MINUTE) BETWEEN 0 AND 120`,
};

// v2 : fenêtre élargie à 3 h… mais les arguments de TIMESTAMP_DIFF sont inversés : l'écart est toujours
// négatif et la règle ne remonte plus rien depuis sa mise en production (régression visible dans le comparatif).
const R4_V2_SQL = R4.sql.replace(
  'TIMESTAMP_DIFF(o.created_at, c.email_changed_at, MINUTE) BETWEEN 0 AND 120',
  'TIMESTAMP_DIFF(c.email_changed_at, o.created_at, MINUTE) BETWEEN 0 AND 180',
);

const R5: Def = {
  id: '7f3c2a10-5b1e-4c8a-9d21-0a1b2c3d4e05',
  owner: '118870',
  name: 'Code promo utilisé par des comptes liés',
  description: "Même code promotionnel « premier achat » utilisé par plusieurs comptes partageant une adresse de livraison.",
  fraudTypology: 'Abus de promotion',
  criticality: 'LOW',
  schedule: 'WEEKLY',
  sql: `WITH usages AS (
  SELECT o.promo_code, o.shipping_address_id, COUNT(DISTINCT o.customer_id) AS nb_comptes
  FROM \`sales.orders\` o
  WHERE o.order_date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 8 DAY) AND DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
    AND o.promo_code IS NOT NULL
  GROUP BY 1, 2
)
SELECT
  o.order_id,
  o.promo_code,
  u.nb_comptes
FROM \`sales.orders\` o
JOIN usages u USING (promo_code, shipping_address_id)
WHERE u.nb_comptes >= 3`,
};

const R5_V2_SQL = R5.sql.replace('>= 3', '>= 2');

const R6: Def = {
  id: '7f3c2a10-5b1e-4c8a-9d21-0a1b2c3d4e06',
  owner: '120415',
  name: 'BIN étranger et montant élevé',
  description: 'Carte émise hors UE, commande au-dessus du seuil, livrée en point relais.',
  fraudTypology: 'Fraude au moyen de paiement',
  criticality: 'HIGH',
  schedule: 'DAILY',
  sql: `SELECT
  o.order_id,
  p.card_country,
  o.amount_eur
FROM \`sales.orders\` o
JOIN \`sales.payments\` p USING (order_id)
JOIN \`sales.deliveries\` d USING (order_id)
WHERE o.order_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
  AND p.card_country != 'FR'
  AND d.delivery_mode = 'RELAY'
  AND o.amount_eur >= 400`,
};

const R7: Def = {
  id: '7f3c2a10-5b1e-4c8a-9d21-0a1b2c3d4e07',
  owner: '104233',
  name: 'Adresse de livraison partagée',
  description: 'Adresse de livraison utilisée par plus de N comptes distincts sur 30 jours.',
  fraudTypology: 'Triangulation / revente',
  criticality: 'MEDIUM',
  schedule: 'DAILY',
  sql: `SELECT
  o.order_id,
  COUNT(DISTINCT o.customer_id) OVER (PARTITION BY o.shipping_address_id) AS nb_comptes
FROM \`sales.orders\` o
WHERE o.order_date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 31 DAY) AND DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
QUALIFY nb_comptes > 4`,
};

const R8: Def = {
  id: '7f3c2a10-5b1e-4c8a-9d21-0a1b2c3d4e08',
  owner: '104233',
  name: 'Panier électronique multi-articles',
  description: "Plusieurs exemplaires d'un même produit high-tech revendable, compte récent.",
  fraudTypology: 'Triangulation / revente',
  criticality: 'MEDIUM',
  schedule: 'DAILY',
  sql: `SELECT
  o.order_id,
  o.item_count
FROM \`sales.orders\` o
WHERE o.order_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
  AND o.item_count >= 4`,
};

function passedTest(r: RuleVersion, at: number, by: string, i: number): TestRecord {
  return {
    id: `seed-test-${r.ruleId.slice(-2)}-${r.version}-${i}`,
    ruleId: r.ruleId,
    version: r.version,
    queryHash: queryHash(r.sqlQuery),
    at: daysAgo(at, 15),
    byMatricule: by,
    byName: name(by),
    phase: 'EXECUTION',
    success: true,
    bytesProcessed: 8.2e9 + i * 1.1e9,
    durationMs: 6400 + i * 500,
    totalRows: 280 + i * 37,
  };
}

export function buildSeed(): MockDb {
  // Versions soumises : leur statut affiché se déduit des runs Airflow simulés.
  // Le DAG d'une règle ne change pas d'une version à l'autre : il lit la ligne de la règle dans rules_registry.
  const r1v1 = v({ ...R1, sql: R1_V1_SQL }, 1, 160, { airflowDagId: dag });
  const r1v2 = v(R1, 2, 95, { airflowDagId: dag });
  const r1v3 = v({ ...R1, sql: R1_V3_SQL }, 3, 40, { airflowDagId: dag });
  const r2v1 = v(R2, 1, 120, { airflowDagId: dag });
  const r2v2 = v({ ...R2, sql: R2_V2_SQL }, 2, 62, { airflowDagId: dag });
  const r3v1 = v(R3, 1, 95, { submittedAt: daysAgo(94), airflowDagId: dag });
  const r4v1 = v(R4, 1, 140, { airflowDagId: dag });
  const r4v2 = v({ ...R4, sql: R4_V2_SQL }, 2, 43, { airflowDagId: dag });
  const r5v1 = v(R5, 1, 70, { airflowDagId: dag });
  const r5v2 = v({ ...R5, sql: R5_V2_SQL }, 2, 6, { submittedAt: daysAgo(5) });
  const r6v1 = v(R6, 1, 12, { submittedAt: daysAgo(11), airflowDagId: dag });
  const r7v1 = v(R7, 1, 20, { submittedAt: daysAgo(19) });
  // Brouillons personnels de Camille Martin : une nouvelle version de R3, une nouvelle règle.
  const drafts: MockDraft[] = [
    { id: 'seed-draft-r3', matricule: '104233', ruleId: R3.id, baseVersion: 1, ...content({ ...R3, sql: R3_V2_SQL }), createdAt: daysAgo(3), updatedAt: daysAgo(2) },
    { id: 'seed-draft-r8', matricule: '104233', ruleId: R8.id, ...content(R8), createdAt: daysAgo(1), updatedAt: daysAgo(0, 9) },
  ];

  const rules: MockRule[] = [
    {
      ruleId: R1.id,
      versions: [r1v1, r1v2, r1v3],
      productionSince: { 1: daysAgo(150).slice(0, 10), 2: daysAgo(92).slice(0, 10), 3: daysAgo(38).slice(0, 10) },
      productionUntil: { 1: daysAgo(93).slice(0, 10), 2: daysAgo(39).slice(0, 10) },
      profile: { dailyVolume: 24, processingRate: 0.82, precision: 0.44 },
      // Chaque version resserre la règle : moins de remontées, plus précises.
      versionProfiles: { 1: { dailyVolume: 61, precision: 0.19 }, 2: { dailyVolume: 34, precision: 0.31 } },
    },
    {
      ruleId: R2.id,
      versions: [r2v1, r2v2],
      productionSince: { 1: daysAgo(115).slice(0, 10), 2: daysAgo(58).slice(0, 10) },
      // Plus aucun run depuis 5 jours : la règle apparaît « inactive ».
      productionUntil: { 1: daysAgo(59).slice(0, 10), 2: daysAgo(5).slice(0, 10) },
      // v2 au seuil de 100 € : plus de volume, un peu moins précise.
      profile: { dailyVolume: 22, processingRate: 0.9, precision: 0.47 },
      versionProfiles: { 1: { dailyVolume: 14, precision: 0.58 } },
    },
    {
      ruleId: R3.id,
      versions: [r3v1],
      productionSince: { 1: daysAgo(90).slice(0, 10) },
      productionUntil: {},
      profile: { dailyVolume: 95, processingRate: 0.31, precision: 0.07 },
    },
    {
      ruleId: R4.id,
      versions: [r4v1, r4v2],
      productionSince: { 1: daysAgo(135).slice(0, 10), 2: daysAgo(41).slice(0, 10) },
      productionUntil: { 1: daysAgo(42).slice(0, 10) },
      profile: { dailyVolume: 6, processingRate: 0.95, precision: 0.71, brokenSinceDays: 42 },
    },
    {
      // v1 en production, v2 soumise : Airflow la prendra au prochain run hebdomadaire.
      ruleId: R5.id,
      versions: [r5v1, r5v2],
      productionSince: { 1: daysAgo(65).slice(0, 10) },
      productionUntil: {},
      profile: { dailyVolume: 3, processingRate: 0.85, precision: 0.52 },
    },
    {
      // En observation depuis 9 jours : exécutée par Airflow, rien n'est envoyé au prestataire.
      ruleId: R6.id,
      versions: [r6v1],
      productionSince: { 1: daysAgo(9).slice(0, 10) },
      productionUntil: {},
      profile: { dailyVolume: 18, processingRate: 0.85, precision: 0.41 },
    },
    { ruleId: R7.id, versions: [r7v1], productionSince: {}, productionUntil: {} },
  ];

  // Les versions qui ont tourné ont été envoyées au prestataire, sauf R6 (en observation).
  for (const rule of rules) {
    if (rule.ruleId === R6.id) continue;
    for (const ver of rule.versions) {
      const since = rule.productionSince[ver.version];
      if (since) Object.assign(ver, { decision: 'SENT', decidedAt: `${since}T09:00:00.000Z`, decidedByName: ver.submittedByName });
    }
  }

  const tests: TestRecord[] = [
    passedTest(r1v1, 161, '104233', 0),
    passedTest(r1v2, 96, '104233', 1),
    passedTest(r1v3, 41, '104233', 11),
    passedTest(r2v1, 121, '118870', 2),
    passedTest(r2v2, 63, '118870', 12),
    passedTest(r3v1, 96, '104233', 3),
    passedTest(r4v1, 141, '120415', 4),
    // Le test de la v2 « réussit » mais ne remonte rien : le signal était là avant la mise en production.
    { ...passedTest(r4v2, 44, '120415', 14), totalRows: 0 },
    passedTest(r5v1, 71, '118870', 5),
    passedTest(r5v2, 6, '118870', 15),
    passedTest(r6v1, 12, '120415', 6),
    passedTest(r7v1, 20, '104233', 7),
    {
      id: 'seed-test-08-1-fail',
      draftId: 'seed-draft-r8',
      queryHash: 'deadbeef',
      at: daysAgo(1, 16),
      byMatricule: '104233',
      byName: name('104233'),
      phase: 'DRY_RUN',
      success: false,
      error: 'Not found: Table sales.order_items was not found at [4:6]',
    },
  ];

  const audit: AuditEvent[] = [];
  let n = 0;
  const ev = (at: string, m: string, action: AuditEvent['action'], r: RuleVersion | undefined, details?: string) =>
    audit.push({ id: `seed-audit-${n++}`, at, matricule: m, userName: name(m), action, ruleId: r?.ruleId, ruleName: r?.name, version: r?.version, details });
  for (const rule of rules) {
    for (const ver of rule.versions) {
      ev(ver.submittedAt, ver.submittedBy, 'RULE_SUBMIT', ver, ver.version === 1 ? 'Nouvelle règle' : 'Nouvelle version');
      if (ver.decision === 'SENT') ev(ver.decidedAt!, ver.submittedBy, 'RULE_SEND_TO_PROVIDER', ver, 'Envoi au prestataire décidé');
    }
  }
  for (const t of tests) {
    // Un test de brouillon est tracé sans nommer la règle (le brouillon est privé).
    const r = rules.find((x) => x.ruleId === t.ruleId)?.versions.find((x) => x.version === t.version);
    const outcome = t.success ? `${t.phase === 'EXECUTION' ? 'Exécution' : 'Dry-run'} réussi` : `Échec : ${t.error}`;
    ev(t.at, t.byMatricule, 'RULE_TEST', r, t.draftId ? `${outcome} (brouillon)` : outcome);
  }
  audit.sort((a, b) => b.at.localeCompare(a.at));

  return { schema: SCHEMA_VERSION, users: USERS.map((u) => ({ ...u })), rules, drafts, tests, audit };
}
