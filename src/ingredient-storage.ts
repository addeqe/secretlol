import { rows } from './database.ts';
import type { Database } from './types.ts';

/** Schema text is also consumed by database initialization and integration tests. */
export function ingredientStorageSchema() { return [
  `CREATE TABLE IF NOT EXISTS ingredient_link_versions (
    ingredient_name TEXT NOT NULL,
    valid_from_revision INTEGER NOT NULL,
    valid_to_revision INTEGER,
    occurrences INTEGER NOT NULL,
    status TEXT NOT NULL,
    selected_code TEXT,
    data_json TEXT NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(ingredient_name,valid_from_revision),
    CHECK(valid_to_revision IS NULL OR valid_to_revision>valid_from_revision)
  ) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS ingredient_link_versions_closed ON ingredient_link_versions(valid_to_revision) WHERE valid_to_revision IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS ingredient_change_history_expiry ON ingredient_change_history(changed_at)',
  `CREATE TABLE IF NOT EXISTS ingredient_run_storage (
    run_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    storage_version INTEGER NOT NULL
  ) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS ingredient_run_storage_revision ON ingredient_run_storage(revision)',
  `CREATE VIEW IF NOT EXISTS ingredient_links_read AS
    SELECT l.run_id,l.ingredient_name,l.occurrences,l.status,l.selected_code,l.data_json
    FROM ingredient_links l LEFT JOIN ingredient_run_storage rs ON rs.run_id=l.run_id
    WHERE rs.run_id IS NULL
    UNION ALL
    SELECT rs.run_id,v.ingredient_name,v.occurrences,v.status,v.selected_code,v.data_json
    FROM ingredient_run_storage rs JOIN ingredient_link_versions v
      ON v.valid_from_revision<=rs.revision AND (v.valid_to_revision IS NULL OR v.valid_to_revision>rs.revision)
      AND NOT EXISTS (SELECT 1 FROM ingredient_link_versions newer WHERE newer.ingredient_name=v.ingredient_name
        AND newer.valid_from_revision<=rs.revision AND newer.valid_from_revision>v.valid_from_revision)
    WHERE v.is_deleted=0`
].join(';'); }

/** Create the versioned connection store. Legacy rows remain available through the read view. */
export async function ensureIngredientStorage(database: Database) {
  for (const statement of ingredientStorageSchema().split(';').map(s=>s.trim()).filter(Boolean)) await database.query(statement);
}

export function compactLink(link: Record<string, any>) {
  const selected = link.selectedProduct;
  const basis = selected?.comparisonUnit ?? link.priceBasis ?? link.candidates?.[0]?.comparisonUnit ?? 'kg';
  const candidateCodes = Array.isArray(link.candidates) ? link.candidates.map((c: any) => c.code) :
    Array.isArray(link.candidateCodes) ? link.candidateCodes : [];
  const { selectedProduct: _selected, candidates: _candidates, ...stable } = link;
  return { ...stable, candidateCodes, priceBasis: basis };
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(v=>v===undefined?'null':stableStringify(v)).join(',')}]`;
  if (value && typeof value === 'object') {
    const object=value as Record<string,unknown>;
    return `{${Object.keys(object).filter(key=>object[key]!==undefined).sort().map(key=>`${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value)??'null';
}

export async function seedIngredientStorage(database: Database, throughRunId?: string) {
  const pending=await rows(database,`SELECT r.id,r.created_at FROM ingredient_runs r
    LEFT JOIN ingredient_run_storage rs ON rs.run_id=r.id
    WHERE r.status='complete' AND rs.run_id IS NULL ORDER BY r.created_at,r.id`);
  if(!pending.length)return;
  const targetIndex=throughRunId?pending.findIndex(r=>String(r.id)===throughRunId):pending.length-1;
  if(throughRunId&&targetIndex<0){
    const mapped=(await rows(database,`SELECT r.created_at FROM ingredient_run_storage rs JOIN ingredient_runs r ON r.id=rs.run_id
      WHERE rs.run_id=?`,[throughRunId]))[0];
    if(mapped){
      if(pending.some(r=>String(r.created_at)<String(mapped.created_at)||String(r.created_at)===String(mapped.created_at)&&String(r.id)<throughRunId))
        throw new Error('Cannot seed ingredient runs out of chronological order');
      return;
    }
    throw new Error('Cannot seed an unknown or incomplete ingredient run');
  }
  for(const legacy of pending.slice(0,targetIndex+1)){
    const runId=String(legacy.id),createdAt=String(legacy.created_at);
    const later=(await rows(database,`SELECT 1 AS found FROM ingredient_run_storage rs JOIN ingredient_runs r ON r.id=rs.run_id
      WHERE r.created_at>? OR (r.created_at=? AND r.id>?) LIMIT 1`,[createdAt,createdAt,runId]))[0];
    if(later)throw new Error('Cannot seed ingredient runs out of chronological order');
    const links=await rows(database,'SELECT ingredient_name,occurrences,status,selected_code,data_json FROM ingredient_links WHERE run_id=?',[runId]);
    const previous=(await rows(database,`SELECT rs.run_id,rs.revision FROM ingredient_run_storage rs JOIN ingredient_runs r ON r.id=rs.run_id
      WHERE r.created_at<? OR (r.created_at=? AND r.id<?) ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,[createdAt,createdAt,runId]))[0];
    const previousId=previous?String(previous.run_id):'';
    const previousLinks=previous?await rows(database,'SELECT ingredient_name,data_json FROM ingredient_links_read WHERE run_id=?',[previousId]):[];
    const previousByName=new Map(previousLinks.map(row=>[String(row.ingredient_name),stableStringify(compactLink(JSON.parse(String(row.data_json))))]));
    const current=links.map(row=>({row,name:String(row.ingredient_name),data:compactLink(JSON.parse(String(row.data_json)))}));
    const currentNames=new Set(current.map(x=>x.name));
    const changed=current.filter(x=>previousByName.get(x.name)!==stableStringify(x.data));
    const removed=[...previousByName.keys()].filter(name=>!currentNames.has(name));
    const revision=Number((await rows(database,'SELECT COALESCE(MAX(revision),0)+1 AS n FROM ingredient_run_storage'))[0]?.n??1);
    await database.query('DELETE FROM ingredient_link_versions WHERE valid_from_revision=? AND NOT EXISTS (SELECT 1 FROM ingredient_run_storage WHERE revision=?)',[revision,revision]);
    try{
      for(let i=0;i<changed.length;i+=100){
        const slice=changed.slice(i,i+100);
        await database.query(`INSERT INTO ingredient_link_versions(ingredient_name,valid_from_revision,occurrences,status,selected_code,data_json)
          SELECT json_extract(value,'$.name'),?,json_extract(value,'$.occurrences'),json_extract(value,'$.status'),
            json_extract(value,'$.selectedCode'),json_extract(value,'$.data') FROM json_each(?)`,
          [revision,JSON.stringify(slice.map(x=>({name:x.name,occurrences:Number(x.row.occurrences),status:String(x.row.status),selectedCode:x.row.selected_code??null,data:JSON.stringify(x.data)})))]);
      }
      for(let i=0;i<removed.length;i+=100){
        await database.query(`INSERT INTO ingredient_link_versions(ingredient_name,valid_from_revision,occurrences,status,selected_code,data_json,is_deleted)
          SELECT value,?,0,'removed',NULL,'{}',1 FROM json_each(?)`,[revision,JSON.stringify(removed.slice(i,i+100))]);
      }
      const verified=(await rows(database,`SELECT COUNT(*) AS n,COALESCE(SUM(occurrences),0) AS occurrences
        FROM ingredient_link_versions v WHERE v.valid_from_revision<=? AND (v.valid_to_revision IS NULL OR v.valid_to_revision>?)
        AND NOT EXISTS(SELECT 1 FROM ingredient_link_versions newer WHERE newer.ingredient_name=v.ingredient_name
          AND newer.valid_from_revision<=? AND newer.valid_from_revision>v.valid_from_revision) AND v.is_deleted=0`,[revision,revision,revision]))[0];
      const expected=links.reduce((n,row)=>n+Number(row.occurrences),0);
      if(Number(verified?.n)!==links.length||Number(verified?.occurrences)!==expected)throw new Error('Existing ingredient connections could not be seeded completely');
      const closeNames=[...new Set([...changed.map(x=>x.name),...removed])];
      await database.batch([
        {sql:`UPDATE ingredient_link_versions SET valid_to_revision=? WHERE valid_to_revision IS NULL AND valid_from_revision<?
          AND ingredient_name IN (SELECT value FROM json_each(?))`,params:[revision,revision,JSON.stringify(closeNames)]},
        {sql:'INSERT INTO ingredient_run_storage VALUES(?,?,1)',params:[runId,revision]}
      ]);
    }catch(error){
      await database.query(`DELETE FROM ingredient_link_versions WHERE valid_from_revision=?
        AND NOT EXISTS(SELECT 1 FROM ingredient_run_storage WHERE revision=?)`,[revision,revision]).catch(()=>{});
      throw error;
    }
  }
}
