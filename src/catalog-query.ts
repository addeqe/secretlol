/**
 * Scalar lookups for one snapshot/code. Keep these branch-specific: joining the
 * compatibility view can materialize every historical product in a store.
 * Each expression contains exactly two snapshot-ID placeholders, in legacy
 * then temporal order. `codeExpression` is trusted SQL assembled by callers.
 */
export function catalogProductLookupSql(codeExpression:string){
  const omit="'$.raw','$.sourcePricing','$.price','$.priceHash'";
  return `(SELECT json_object('product',json_remove(e.data_json,${omit}),'packLabel',json_extract(e.data_json,'$.raw.displayVolume'))
    FROM catalog_entries e WHERE e.snapshot_id=? AND e.code=${codeExpression}
      AND NOT EXISTS(SELECT 1 FROM catalog_snapshot_storage cs WHERE cs.snapshot_id=e.snapshot_id)
    UNION ALL
    SELECT json_object('product',json_remove(json_set(v.data_json,'$.observedAt',cs.oldest_observation_at),${omit}),
      'packLabel',json_extract(v.data_json,'$.raw.displayVolume'))
    FROM catalog_snapshot_storage cs JOIN snapshots s ON s.id=cs.snapshot_id
      JOIN catalog_product_versions v ON v.store_id=s.store_id AND v.valid_from<=cs.revision
        AND (v.valid_to IS NULL OR v.valid_to>cs.revision)
    WHERE cs.snapshot_id=? AND v.code=${codeExpression} LIMIT 1)`;
}

/** Compact status-only projection used by meal availability scans. */
export function catalogAvailabilityLookupSql(codeExpression:string){
  return `(SELECT json_object('available',json_extract(e.data_json,'$.available'),
      'offers',json_extract(e.data_json,'$.offers'),'observedAt',json_extract(e.data_json,'$.observedAt'))
    FROM catalog_entries e WHERE e.snapshot_id=? AND e.code=${codeExpression}
      AND NOT EXISTS(SELECT 1 FROM catalog_snapshot_storage cs WHERE cs.snapshot_id=e.snapshot_id)
    UNION ALL
    SELECT json_object('available',json_extract(v.data_json,'$.available'),
      'offers',json_extract(v.data_json,'$.offers'),'observedAt',cs.oldest_observation_at)
    FROM catalog_snapshot_storage cs JOIN snapshots s ON s.id=cs.snapshot_id
      JOIN catalog_product_versions v ON v.store_id=s.store_id AND v.valid_from<=cs.revision
        AND (v.valid_to IS NULL OR v.valid_to>cs.revision)
    WHERE cs.snapshot_id=? AND v.code=${codeExpression} LIMIT 1)`;
}

/**
 * Bounded keyset page over both storage layouts. Each arm scans at most the
 * requested page size using its primary-key order; the outer sort sees at
 * most twice that many rows. Bind snapshot, cursor, arm-limit twice, then the
 * outer limit.
 */
export function catalogPageSql(){
  const omit="'$.raw','$.price','$.priceHash'";
  return `SELECT code,data_json FROM (
    SELECT code,data_json FROM (
      SELECT e.code,json_remove(e.data_json,${omit}) AS data_json FROM catalog_entries e
      WHERE e.snapshot_id=? AND e.code>? AND NOT EXISTS(
        SELECT 1 FROM catalog_snapshot_storage cs WHERE cs.snapshot_id=e.snapshot_id)
      ORDER BY e.code LIMIT ?
    )
    UNION ALL
    SELECT code,data_json FROM (
      SELECT v.code,json_remove(json_set(v.data_json,'$.observedAt',cs.oldest_observation_at),${omit}) AS data_json
      FROM catalog_snapshot_storage cs JOIN snapshots s ON s.id=cs.snapshot_id
      JOIN catalog_product_versions v ON v.store_id=s.store_id AND v.valid_from<=cs.revision
        AND (v.valid_to IS NULL OR v.valid_to>cs.revision)
      WHERE cs.snapshot_id=? AND v.code>? ORDER BY v.code LIMIT ?
    )
  ) ORDER BY code LIMIT ?`;
}
