-- V1 · B4 · Inventario de afectados por la fuente única de coste (D-OP-10, D-OP-15)
-- SÓLO LECTURA. Ejecutar dentro de:  BEGIN READ ONLY;  <cada consulta>  ROLLBACK;
-- No lleva emails ni ids de usuario: sólo ids y nombres de bot, nombres de equipo y de torneo.
-- Cuatro consultas independientes (Q1..Q4), separadas por «-- ===== Qn =====».
-- Regla de coste nuevo = packages/module-catalog/validator `loadoutCostCredits`:
--   chasis + módulos explícitos + munición embebida (`ammo:` de un arma) no montada además como módulo.
-- Coste antiguo = chasis + módulos explícitos (lo que enseñaban el editor y las reglas de batalla).

-- ===== Q1 =====
WITH ldt AS (   -- un loadout por (bot, versión) de competición, con sus piezas resueltas contra el catálogo
  SELECT b.id AS bot_id, b.name AS bot_name, (b.retired_at IS NOT NULL) AS retired,
         v.version, v.state, l.revision, l.catalog_version, l.chassis, l.modules
  FROM bot_versions v
  JOIN bots b ON b.id = v.bot_id
  JOIN bot_loadouts l ON l.bot_id = v.bot_id AND l.revision = v.loadout_revision
  WHERE v.state IN ('published', 'frozen')
),
piece AS (      -- chasis + módulos explícitos: (loadout, id versionado, coste, categoría)
  SELECT d.bot_id, d.version, p.id AS piece_id, md.category, (md.definition->>'costCredits')::int AS cost
  FROM ldt d
  CROSS JOIN LATERAL (
    SELECT d.chassis AS id
    UNION ALL
    SELECT e->>'moduleId' FROM jsonb_array_elements(d.modules) e
  ) p
  LEFT JOIN module_definitions md
    ON md.catalog_version = d.catalog_version
   AND md.module_id = substring(p.id from '^(.*)@[0-9]+$')
   AND md.module_version = substring(p.id from '@([0-9]+)$')::int
),
embedded AS (   -- munición embebida (`ammo:` del arma) que NO está además montada como módulo explícito
  SELECT d.bot_id, d.version, a.ammo AS piece_id, (amd.definition->>'costCredits')::int AS cost
  FROM ldt d
  CROSS JOIN LATERAL (
    SELECT e->>'moduleId' AS weapon, e->>'ammo' AS ammo
    FROM jsonb_array_elements(d.modules) e
    WHERE jsonb_typeof(e->'ammo') = 'string'
  ) a
  JOIN module_definitions wmd
    ON wmd.catalog_version = d.catalog_version
   AND wmd.module_id = substring(a.weapon from '^(.*)@[0-9]+$')
   AND wmd.module_version = substring(a.weapon from '@([0-9]+)$')::int
   AND wmd.category = 'weapon'
  JOIN module_definitions amd
    ON amd.catalog_version = d.catalog_version
   AND amd.module_id = substring(a.ammo from '^(.*)@[0-9]+$')
   AND amd.module_version = substring(a.ammo from '@([0-9]+)$')::int
   AND amd.category = 'ammo'
  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d.modules) x WHERE x->>'moduleId' = a.ammo)
),
cost AS (
  SELECT d.bot_id, d.bot_name, d.retired, d.version, d.state, d.revision, d.catalog_version, d.chassis,
         COALESCE((SELECT sum(cost) FROM piece p WHERE p.bot_id = d.bot_id AND p.version = d.version), 0)::int AS cost_old,
         COALESCE((SELECT sum(cost) FROM embedded m WHERE m.bot_id = d.bot_id AND m.version = d.version), 0)::int AS ammo_embedded,
         (SELECT count(*) FROM piece p WHERE p.bot_id = d.bot_id AND p.version = d.version AND p.cost IS NULL)::int AS unresolved
  FROM ldt d
),
v AS (SELECT *, cost_old + ammo_embedded AS cost_new FROM cost)

-- Q1 · detalle por versión publicada/congelada (ids y nombres de bot; sin datos de usuario)
SELECT v.bot_name, v.bot_id, v.version, v.state, v.retired, v.catalog_version, v.chassis,
       v.cost_old, v.ammo_embedded, v.cost_new,
       (v.cost_new > 1000) AS invalid_vs_practice_1000,
       (v.cost_new > 800)  AS over_800,
       (v.cost_new > 500)  AS over_500,
       (v.cost_new > 200)  AS over_200,
       v.unresolved AS pieces_unresolved,
       (SELECT string_agg(DISTINCT t.name, ', ' ORDER BY t.name) FROM teams t
         WHERE t.id = (SELECT bb.team_id FROM bots bb WHERE bb.id = v.bot_id)) AS team_current,
       (SELECT string_agg(DISTINCT t.name, ', ' ORDER BY t.name) FROM entries en JOIN teams t ON t.id = en.team_id
         WHERE en.bot_id = v.bot_id AND en.version = v.version) AS teams_in_entries
FROM v
ORDER BY v.cost_new DESC, v.bot_name, v.version;

-- ===== Q2 =====
WITH ldt AS (   -- un loadout por (bot, versión) de competición, con sus piezas resueltas contra el catálogo
  SELECT b.id AS bot_id, b.name AS bot_name, (b.retired_at IS NOT NULL) AS retired,
         v.version, v.state, l.revision, l.catalog_version, l.chassis, l.modules
  FROM bot_versions v
  JOIN bots b ON b.id = v.bot_id
  JOIN bot_loadouts l ON l.bot_id = v.bot_id AND l.revision = v.loadout_revision
  WHERE v.state IN ('published', 'frozen')
),
piece AS (      -- chasis + módulos explícitos: (loadout, id versionado, coste, categoría)
  SELECT d.bot_id, d.version, p.id AS piece_id, md.category, (md.definition->>'costCredits')::int AS cost
  FROM ldt d
  CROSS JOIN LATERAL (
    SELECT d.chassis AS id
    UNION ALL
    SELECT e->>'moduleId' FROM jsonb_array_elements(d.modules) e
  ) p
  LEFT JOIN module_definitions md
    ON md.catalog_version = d.catalog_version
   AND md.module_id = substring(p.id from '^(.*)@[0-9]+$')
   AND md.module_version = substring(p.id from '@([0-9]+)$')::int
),
embedded AS (   -- munición embebida (`ammo:` del arma) que NO está además montada como módulo explícito
  SELECT d.bot_id, d.version, a.ammo AS piece_id, (amd.definition->>'costCredits')::int AS cost
  FROM ldt d
  CROSS JOIN LATERAL (
    SELECT e->>'moduleId' AS weapon, e->>'ammo' AS ammo
    FROM jsonb_array_elements(d.modules) e
    WHERE jsonb_typeof(e->'ammo') = 'string'
  ) a
  JOIN module_definitions wmd
    ON wmd.catalog_version = d.catalog_version
   AND wmd.module_id = substring(a.weapon from '^(.*)@[0-9]+$')
   AND wmd.module_version = substring(a.weapon from '@([0-9]+)$')::int
   AND wmd.category = 'weapon'
  JOIN module_definitions amd
    ON amd.catalog_version = d.catalog_version
   AND amd.module_id = substring(a.ammo from '^(.*)@[0-9]+$')
   AND amd.module_version = substring(a.ammo from '@([0-9]+)$')::int
   AND amd.category = 'ammo'
  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d.modules) x WHERE x->>'moduleId' = a.ammo)
),
cost AS (
  SELECT d.bot_id, d.bot_name, d.retired, d.version, d.state, d.revision, d.catalog_version, d.chassis,
         COALESCE((SELECT sum(cost) FROM piece p WHERE p.bot_id = d.bot_id AND p.version = d.version), 0)::int AS cost_old,
         COALESCE((SELECT sum(cost) FROM embedded m WHERE m.bot_id = d.bot_id AND m.version = d.version), 0)::int AS ammo_embedded,
         (SELECT count(*) FROM piece p WHERE p.bot_id = d.bot_id AND p.version = d.version AND p.cost IS NULL)::int AS unresolved
  FROM ldt d
),
v AS (SELECT *, cost_old + ammo_embedded AS cost_new FROM cost)

-- Q2 · resumen por umbral de presupuesto (cuántas versiones publicadas/congeladas superarían cada tope)
SELECT t.threshold AS budget_credits,
       count(*) FILTER (WHERE v.cost_old > t.threshold) AS versions_over_old_cost,
       count(*) FILTER (WHERE v.cost_new > t.threshold) AS versions_over_new_cost,
       count(*) FILTER (WHERE v.cost_new > t.threshold AND v.cost_old <= t.threshold) AS newly_over_due_to_ammo,
       count(DISTINCT v.bot_id) FILTER (WHERE v.cost_new > t.threshold) AS bots_over_new_cost,
       count(*) AS versions_total
FROM v CROSS JOIN (VALUES (200), (300), (500), (800), (880), (1000)) AS t(threshold)
GROUP BY t.threshold ORDER BY t.threshold;

-- ===== Q3 =====
WITH ldt AS (   -- un loadout por (bot, versión) de competición, con sus piezas resueltas contra el catálogo
  SELECT b.id AS bot_id, b.name AS bot_name, (b.retired_at IS NOT NULL) AS retired,
         v.version, v.state, l.revision, l.catalog_version, l.chassis, l.modules
  FROM bot_versions v
  JOIN bots b ON b.id = v.bot_id
  JOIN bot_loadouts l ON l.bot_id = v.bot_id AND l.revision = v.loadout_revision
  WHERE v.state IN ('published', 'frozen')
),
piece AS (      -- chasis + módulos explícitos: (loadout, id versionado, coste, categoría)
  SELECT d.bot_id, d.version, p.id AS piece_id, md.category, (md.definition->>'costCredits')::int AS cost
  FROM ldt d
  CROSS JOIN LATERAL (
    SELECT d.chassis AS id
    UNION ALL
    SELECT e->>'moduleId' FROM jsonb_array_elements(d.modules) e
  ) p
  LEFT JOIN module_definitions md
    ON md.catalog_version = d.catalog_version
   AND md.module_id = substring(p.id from '^(.*)@[0-9]+$')
   AND md.module_version = substring(p.id from '@([0-9]+)$')::int
),
embedded AS (   -- munición embebida (`ammo:` del arma) que NO está además montada como módulo explícito
  SELECT d.bot_id, d.version, a.ammo AS piece_id, (amd.definition->>'costCredits')::int AS cost
  FROM ldt d
  CROSS JOIN LATERAL (
    SELECT e->>'moduleId' AS weapon, e->>'ammo' AS ammo
    FROM jsonb_array_elements(d.modules) e
    WHERE jsonb_typeof(e->'ammo') = 'string'
  ) a
  JOIN module_definitions wmd
    ON wmd.catalog_version = d.catalog_version
   AND wmd.module_id = substring(a.weapon from '^(.*)@[0-9]+$')
   AND wmd.module_version = substring(a.weapon from '@([0-9]+)$')::int
   AND wmd.category = 'weapon'
  JOIN module_definitions amd
    ON amd.catalog_version = d.catalog_version
   AND amd.module_id = substring(a.ammo from '^(.*)@[0-9]+$')
   AND amd.module_version = substring(a.ammo from '@([0-9]+)$')::int
   AND amd.category = 'ammo'
  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d.modules) x WHERE x->>'moduleId' = a.ammo)
),
cost AS (
  SELECT d.bot_id, d.bot_name, d.retired, d.version, d.state, d.revision, d.catalog_version, d.chassis,
         COALESCE((SELECT sum(cost) FROM piece p WHERE p.bot_id = d.bot_id AND p.version = d.version), 0)::int AS cost_old,
         COALESCE((SELECT sum(cost) FROM embedded m WHERE m.bot_id = d.bot_id AND m.version = d.version), 0)::int AS ammo_embedded,
         (SELECT count(*) FROM piece p WHERE p.bot_id = d.bot_id AND p.version = d.version AND p.cost IS NULL)::int AS unresolved
  FROM ldt d
),
v AS (SELECT *, cost_old + ammo_embedded AS cost_new FROM cost)

-- Q3 · inscripciones YA existentes en torneos con presupuesto propio que superarían el nuevo coste
--      (se conservan: la política de transición no revoca nada; se listan para decidirlo)
SELECT tr.name AS tournament, tr.state AS tournament_state, tr.budget_credits,
       v.bot_name, v.bot_id, v.version, v.cost_old, v.cost_new, (v.cost_new - tr.budget_credits) AS excess_new,
       (v.cost_old > tr.budget_credits) AS already_over_with_old_cost
FROM entries en
JOIN tournaments tr ON tr.id = en.tournament_id
JOIN v ON v.bot_id = en.bot_id AND v.version = en.version
WHERE tr.budget_credits IS NOT NULL AND v.cost_new > tr.budget_credits
ORDER BY tr.name, v.cost_new DESC;

-- ===== Q4 =====
WITH ldt AS (   -- un loadout por (bot, versión) de competición, con sus piezas resueltas contra el catálogo
  SELECT b.id AS bot_id, b.name AS bot_name, (b.retired_at IS NOT NULL) AS retired,
         v.version, v.state, l.revision, l.catalog_version, l.chassis, l.modules
  FROM bot_versions v
  JOIN bots b ON b.id = v.bot_id
  JOIN bot_loadouts l ON l.bot_id = v.bot_id AND l.revision = v.loadout_revision
  WHERE v.state IN ('published', 'frozen')
),
piece AS (      -- chasis + módulos explícitos: (loadout, id versionado, coste, categoría)
  SELECT d.bot_id, d.version, p.id AS piece_id, md.category, (md.definition->>'costCredits')::int AS cost
  FROM ldt d
  CROSS JOIN LATERAL (
    SELECT d.chassis AS id
    UNION ALL
    SELECT e->>'moduleId' FROM jsonb_array_elements(d.modules) e
  ) p
  LEFT JOIN module_definitions md
    ON md.catalog_version = d.catalog_version
   AND md.module_id = substring(p.id from '^(.*)@[0-9]+$')
   AND md.module_version = substring(p.id from '@([0-9]+)$')::int
),
embedded AS (   -- munición embebida (`ammo:` del arma) que NO está además montada como módulo explícito
  SELECT d.bot_id, d.version, a.ammo AS piece_id, (amd.definition->>'costCredits')::int AS cost
  FROM ldt d
  CROSS JOIN LATERAL (
    SELECT e->>'moduleId' AS weapon, e->>'ammo' AS ammo
    FROM jsonb_array_elements(d.modules) e
    WHERE jsonb_typeof(e->'ammo') = 'string'
  ) a
  JOIN module_definitions wmd
    ON wmd.catalog_version = d.catalog_version
   AND wmd.module_id = substring(a.weapon from '^(.*)@[0-9]+$')
   AND wmd.module_version = substring(a.weapon from '@([0-9]+)$')::int
   AND wmd.category = 'weapon'
  JOIN module_definitions amd
    ON amd.catalog_version = d.catalog_version
   AND amd.module_id = substring(a.ammo from '^(.*)@[0-9]+$')
   AND amd.module_version = substring(a.ammo from '@([0-9]+)$')::int
   AND amd.category = 'ammo'
  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d.modules) x WHERE x->>'moduleId' = a.ammo)
),
cost AS (
  SELECT d.bot_id, d.bot_name, d.retired, d.version, d.state, d.revision, d.catalog_version, d.chassis,
         COALESCE((SELECT sum(cost) FROM piece p WHERE p.bot_id = d.bot_id AND p.version = d.version), 0)::int AS cost_old,
         COALESCE((SELECT sum(cost) FROM embedded m WHERE m.bot_id = d.bot_id AND m.version = d.version), 0)::int AS ammo_embedded,
         (SELECT count(*) FROM piece p WHERE p.bot_id = d.bot_id AND p.version = d.version AND p.cost IS NULL)::int AS unresolved
  FROM ldt d
),
v AS (SELECT *, cost_old + ammo_embedded AS cost_new FROM cost)

-- Q4 · por equipo (bots.team_id actual): bots/versiones publicadas del equipo y su coste nuevo máximo / suma
SELECT t.name AS team, count(DISTINCT v.bot_id) AS bots, count(*) AS versions,
       max(v.cost_old) AS max_cost_old, max(v.cost_new) AS max_cost_new,
       count(*) FILTER (WHERE v.cost_new > 1000) AS versions_over_1000,
       count(*) FILTER (WHERE v.cost_new <> v.cost_old) AS versions_with_embedded_ammo
FROM v JOIN bots b ON b.id = v.bot_id JOIN teams t ON t.id = b.team_id
GROUP BY t.name ORDER BY max(v.cost_new) DESC, t.name;
