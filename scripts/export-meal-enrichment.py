"""Export a bounded, versioned recipe-filter/profile overlay from two SQLite snapshots.

This prepares local gzip chunks only. It does not contact or write to Cloudflare.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import pathlib
import sqlite3
from collections import defaultdict


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def parse_readiness(data: bytes) -> tuple[dict[int, int], str, str]:
    """Parse the advisory recipeId -> unresolved-price-count input."""
    document = json.loads(data)
    if not isinstance(document, dict):
        raise ValueError("Readiness JSON must be a recipeId-to-unresolved-count map")
    payload = document
    for key in ("recipeUnresolvedCounts", "recipeIdToUnresolvedCount",
                "unresolvedPriceReadinessByRecipeId", "counts"):
        if key in document:
            payload = document[key]
            break
    else:
        metadata_keys = {"readinessBuildId", "buildId", "sourceSha256", "inputSha256s",
                         "schemaVersion", "builtAt", "source", "summary"}
        if metadata_keys.intersection(document):
            payload = {key: value for key, value in document.items() if key not in metadata_keys}
    if not isinstance(payload, dict):
        raise ValueError("Readiness JSON count map must be an object")
    counts: dict[int, int] = {}
    for raw_id, value in payload.items():
        try:
            recipe_id = int(raw_id)
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError(f"Invalid recipe ID in readiness map: {raw_id!r}") from exc
        if str(recipe_id) != str(raw_id) or recipe_id < 0:
            raise ValueError(f"Noncanonical recipe ID in readiness map: {raw_id!r}")
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f"Invalid unresolved-count for recipe {raw_id}: expected a nonnegative integer")
        if recipe_id in counts:
            raise ValueError(f"Duplicate normalized recipe ID in readiness map: {raw_id!r}")
        counts[recipe_id] = value
    checksum = sha(data)
    build_id = document.get("readinessBuildId", document.get("buildId", checksum))
    if not isinstance(build_id, str) or not build_id.strip():
        raise ValueError("Readiness build ID must be a nonempty string")
    return counts, checksum, build_id


def compact(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


def open_readonly(path: pathlib.Path) -> sqlite3.Connection:
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    return db


def compare_unchanged(base: sqlite3.Connection, revised: sqlite3.Connection) -> dict[str, int]:
    """Prove the selected recipe source and approved shopping basis are unchanged."""
    result: dict[str, int] = {}
    for table, order in (
        ("recipes", "CAST(RecipeId AS INTEGER)"),
        ("ingredients", "RecipeId,ingredient_index"),
        ("reviews", "RecipeId,ReviewId"),
        ("ingredient_product_connections", "ingredient_name"),
        ("recipe_ingredient_quality", "RecipeId"),
    ):
        before = base.execute(f"SELECT * FROM {table} ORDER BY {order}")
        after = revised.execute(f"SELECT * FROM {table} ORDER BY {order}")
        count = 0
        while True:
            left, right = before.fetchone(), after.fetchone()
            if left is None or right is None:
                if left is not right:
                    raise ValueError(f"Base and revised snapshots differ in {table} row count")
                break
            if tuple(left) != tuple(right):
                raise ValueError(f"Base and revised snapshots differ in {table}; enrichment export is unsafe")
            count += 1
        result[table] = count
    return result


def database_counts(db: sqlite3.Connection) -> dict[str, int]:
    return {table: int(db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            for table in ("recipes", "ingredients", "reviews")}


def definitions(db: sqlite3.Connection) -> list[dict]:
    output = []
    for row in db.execute("SELECT * FROM filter_definitions ORDER BY filter_id"):
        value = dict(row)
        value["rule"] = json.loads(value.pop("rule_json"))
        output.append(value)
    return output


def gzip_write(path: pathlib.Path, data: bytes) -> dict:
    with path.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=6) as compressed:
            compressed.write(data)
    zipped = path.read_bytes()
    return {"file": path.name, "sha256": sha(zipped), "bytes": len(zipped),
            "contentSha256": sha(data), "uncompressedBytes": len(data)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=pathlib.Path, required=True, help="Immutable currently published filter SQLite file")
    parser.add_argument("--updated", type=pathlib.Path, required=True, help="New local filter SQLite file")
    parser.add_argument("--base-manifest", type=pathlib.Path, default=pathlib.Path("meal-data/manifest.json"))
    parser.add_argument("--output", type=pathlib.Path, default=pathlib.Path("data/meal-enrichment-20261010"))
    parser.add_argument("--readiness", type=pathlib.Path,
                        help="Optional JSON recipeId-to-unresolved-price-readiness count map")
    parser.add_argument("--chunk-width", type=int, default=1024)
    parser.add_argument("--max-chunk-bytes", type=int, default=750_000)
    args = parser.parse_args()
    if args.chunk_width != 1024:
        raise ValueError("This exporter uses the worker's fixed recipe chunk width of 1024")
    if args.max_chunk_bytes < 100_000 or args.max_chunk_bytes > 1_500_000:
        raise ValueError("max chunk size must be between 100KB and 1.5MB")
    if not args.base.is_file() or not args.updated.is_file() or not args.base_manifest.is_file():
        raise ValueError("Base, updated, and base manifest files must all exist")
    readiness_counts: dict[int, int] | None = None
    readiness_sha256: str | None = None
    readiness_build_id: str | None = None
    readiness_source: dict = {}
    readiness_summary: dict = {}
    if args.readiness is not None:
        if not args.readiness.is_file():
            raise ValueError("Readiness JSON file does not exist")
        readiness_bytes = args.readiness.read_bytes()
        readiness_counts, readiness_sha256, readiness_build_id = parse_readiness(readiness_bytes)
        readiness_document = json.loads(readiness_bytes)
        readiness_source = readiness_document.get("source", {})
        readiness_summary = readiness_document.get("summary", {})
        if not isinstance(readiness_source, dict) or not isinstance(readiness_summary, dict):
            raise ValueError("Readiness source and summary metadata must be objects")

    base_manifest = json.loads(args.base_manifest.read_text(encoding="utf-8"))
    base_id = str(base_manifest.get("datasetId", ""))
    if len(base_id) != 64 or any(ch not in "0123456789abcdef" for ch in base_id):
        raise ValueError("Base dataset manifest has no valid immutable datasetId")
    if sha_file(args.base) != base_id:
        raise ValueError("Base SQLite SHA256 does not match the pinned immutable dataset ID")
    base, revised = open_readonly(args.base), open_readonly(args.updated)
    args.output.mkdir(parents=True, exist_ok=True)
    if any(args.output.iterdir()):
        raise ValueError("Output directory is not empty; choose a new versioned output path")

    counts = database_counts(base)
    if counts != database_counts(revised):
        raise ValueError("Recipe, ingredient, and review counts changed")
    if counts["recipes"] != int(base_manifest["recipes"]) or counts["reviews"] != int(base_manifest["reviews"]):
        raise ValueError("Base snapshot counts do not match its published meal manifest")
    invariant_counts = compare_unchanged(base, revised)

    old_defs, new_defs = definitions(base), definitions(revised)
    if old_defs != new_defs:
        raise ValueError("Filter definition IDs or contracts changed; an overlay cannot safely replace them")
    inv_rows = [{"name": str(r[0]), "occurrences": int(r[1])} for r in base.execute(
        "SELECT ingredient_original,COUNT(*) FROM ingredients GROUP BY ingredient_original ORDER BY ingredient_original")]
    updated_inv = [{"name": str(r[0]), "occurrences": int(r[1])} for r in revised.execute(
        "SELECT ingredient_original,COUNT(*) FROM ingredients GROUP BY ingredient_original ORDER BY ingredient_original")]
    if inv_rows != updated_inv or len(inv_rows) != int(base_manifest["distinctIngredients"]):
        raise ValueError("Ingredient inventory changed")
    inventory_hash = sha(compact(inv_rows))
    if inventory_hash != base_manifest["inventoryHash"]:
        raise ValueError("Base inventory hash does not match its published manifest")
    recipe_ids = [int(r[0]) for r in base.execute("SELECT RecipeId FROM recipes ORDER BY CAST(RecipeId AS INTEGER)")]
    if recipe_ids != [int(r[0]) for r in revised.execute("SELECT RecipeId FROM recipes ORDER BY CAST(RecipeId AS INTEGER)")]:
        raise ValueError("Recipe IDs changed")
    recipe_ids_hash = sha(compact(recipe_ids))
    if readiness_counts is not None and set(readiness_counts) != set(recipe_ids):
        missing = len(set(recipe_ids) - set(readiness_counts))
        extra = len(set(readiness_counts) - set(recipe_ids))
        raise ValueError(f"Readiness map recipe IDs differ from immutable inventory (missing={missing}, extra={extra})")
    readiness_manifest = None
    if readiness_counts is not None:
        source_recipe_count = readiness_source.get("recipeCount")
        source_ingredient_count = readiness_source.get("ingredientLineCount")
        if source_recipe_count != counts["recipes"] or source_ingredient_count != counts["ingredients"]:
            raise ValueError("Readiness source counts do not match the immutable recipe/ingredient snapshot")
        if readiness_source.get("missingIngredientConnections") != 0:
            raise ValueError("Readiness build reports missing approved ingredient connections")
        conversion_sha = readiness_source.get("conversionAssetSha256")
        conversion_file = pathlib.Path(__file__).resolve().parent.parent / "src" / "meal-conversions-data.json"
        if conversion_sha is not None and (not conversion_file.is_file() or sha_file(conversion_file) != conversion_sha):
            raise ValueError("Readiness build references a different conversion asset")
        current_summary = readiness_summary.get("currentAfterUSDA", {})
        if not isinstance(current_summary, dict):
            raise ValueError("Readiness currentAfterUSDA summary must be an object")
        if (current_summary.get("unresolvedPriceReadinessCount") != sum(readiness_counts.values())
                or current_summary.get("recipesWithNoUnresolvedPurchasedLines") != sum(value == 0 for value in readiness_counts.values())):
            raise ValueError("Readiness count map does not reconcile with its audited summary")
        readiness_manifest = {
            "fieldIndex": 14, "field": "unresolvedPriceReadinessCount",
            "advisory": True, "mayExcludeRecipes": False,
            "readinessBuildId": readiness_build_id, "readinessSha256": readiness_sha256,
            "recipeCount": len(readiness_counts), "conversionAssetSha256": conversion_sha,
            "currentAfterUSDA": {
                "pricedLines": current_summary.get("pricedLines"),
                "unresolvedLines": current_summary.get("unresolvedLines"),
                "notPurchasedLines": current_summary.get("notPurchasedLines"),
                "recipesWithNoUnresolvedPurchasedLines": current_summary.get("recipesWithNoUnresolvedPurchasedLines"),
            },
        }

    new_run = revised.execute("SELECT classifier_version,details_json FROM classification_runs ORDER BY created_utc DESC LIMIT 1").fetchone()
    details = json.loads(new_run["details_json"])
    code_hashes = details.get("classifierFilesSha256", {})
    revision_digest = sha(compact({"version": new_run["classifier_version"], "code": code_hashes,
                                   "source": details.get("sourceMainSha256"), "baseDatasetId": base_id,
                                   "exporterSha256": sha_file(pathlib.Path(__file__).resolve()),
                                   "readinessSha256": readiness_sha256,
                                   "readinessBuildId": readiness_build_id}))[:20]
    revision = f"{new_run['classifier_version']}-{revision_digest}"

    # Include only classification rows whose evidence or result changed.
    filters_by_chunk: dict[int, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(list))
    changed_recipe_axes = 0
    revised.execute("ATTACH DATABASE ? AS old", (str(args.base.resolve()),))
    changed_filters: dict[int, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(list))
    for row in revised.execute("""
      SELECT n.RecipeId,n.filter_id,n.state,n.reason,n.evidence,n.method
      FROM recipe_filter_classifications n
      LEFT JOIN old.recipe_filter_classifications o USING(RecipeId,filter_id)
      WHERE o.filter_id IS NULL OR n.state IS NOT o.state OR n.reason IS NOT o.reason
        OR n.evidence IS NOT o.evidence OR n.method IS NOT o.method
      ORDER BY CAST(n.RecipeId AS INTEGER),n.filter_id
    """):
        recipe_id = int(row["RecipeId"])
        changed_filters[recipe_id // args.chunk_width][str(recipe_id)].append({
            "filter_id": int(row["filter_id"]), "state": row["state"], "reason": row["reason"],
            "evidence": row["evidence"], "method": row["method"]})
        changed_recipe_axes += 1

    profiles_by_chunk: dict[int, dict[str, dict]] = defaultdict(dict)
    source_patch_by_chunk: dict[int, dict[str, dict]] = defaultdict(dict)
    all_recipe_chunks: set[int] = set()
    planning_vectors: list[list] = []
    names = [str(r[0]) for r in revised.execute("SELECT ingredient_name FROM ingredient_filter_subjects ORDER BY ingredient_name")]
    name_index = {name: index for index, name in enumerate(names)}
    ingredient_indexes: dict[int, list[int]] = defaultdict(list)
    for row in revised.execute("SELECT RecipeId,ingredient_original FROM ingredients ORDER BY CAST(RecipeId AS INTEGER),ingredient_index"):
        ingredient_indexes[int(row["RecipeId"])].append(name_index[str(row["ingredient_original"])])

    nutrient_fields = ("Calories", "FatContent", "SaturatedFatContent", "CholesterolContent", "SodiumContent",
                       "CarbohydrateContent", "FiberContent", "SugarContent", "ProteinContent")
    for row in revised.execute("""
      SELECT r.RecipeId,r.Name,r.RecipeServings,p.run_id,p.ingredient_count,p.unknown_allergen_axes,
        p.unknown_diet_axes,p.cuisine_assigned,p.meal_type_assigned,p.taste_assigned,p.nutrition_metrics_json
      FROM recipes r JOIN recipe_filter_profiles p USING(RecipeId) ORDER BY CAST(r.RecipeId AS INTEGER)
    """):
        rid = int(row["RecipeId"])
        chunk = rid // args.chunk_width
        all_recipe_chunks.add(chunk)
        metrics = json.loads(row["nutrition_metrics_json"])
        profiles_by_chunk[chunk][str(rid)] = {
            "ingredient_count": int(row["ingredient_count"]),
            "unknown_allergen_axes": int(row["unknown_allergen_axes"]),
            "unknown_diet_axes": int(row["unknown_diet_axes"]),
            "cuisine_assigned": int(row["cuisine_assigned"]),
            "meal_type_assigned": int(row["meal_type_assigned"]),
            "taste_assigned": int(row["taste_assigned"]), "nutrition_metrics": metrics,
        }
        source_raw = row["RecipeServings"]
        source_missing = source_raw is None or (isinstance(source_raw, str) and not source_raw.strip())
        if source_missing and metrics.get("recipe_servings") is not None \
                and str(metrics.get("recipe_servings_provenance", "")).startswith("RecipeYield:"):
            recovered = metrics["recipe_servings"]
            source_patch_by_chunk[chunk][str(rid)] = {
                "RecipeServings": int(recovered) if float(recovered).is_integer() else recovered,
                "RecipeServingsRecoveryProvenance": metrics["recipe_servings_provenance"],
            }

        per_serving = metrics.get("nutrients_per_serving", {})
        values = []
        for field in nutrient_fields:
            value = per_serving.get(field)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                values.append(None)
            elif not (float("-inf") < float(value) < float("inf")):
                values.append(None)
            else:
                values.append(value)
        servings = metrics.get("recipe_servings")
        if isinstance(servings, bool) or not isinstance(servings, (int, float)) or servings <= 0:
            servings = None
        vector = [rid, servings, *values, len(ingredient_indexes[rid]),
                  ingredient_indexes[rid], str(row["Name"])]
        if readiness_counts is not None:
            vector.append(readiness_counts[rid])
        planning_vectors.append(vector)

    changed_ingredient_names = sorted({str(r[0]) for r in revised.execute("""
      SELECT DISTINCT n.ingredient_name FROM ingredient_filter_classifications n
      LEFT JOIN old.ingredient_filter_classifications o
        ON o.ingredient_name=n.ingredient_name AND o.filter_id=n.filter_id
      WHERE o.filter_id IS NULL OR n.state IS NOT o.state OR n.reason IS NOT o.reason
        OR n.evidence IS NOT o.evidence OR n.method IS NOT o.method
    """)})
    ingredient_filters: dict[str, list[dict]] = defaultdict(list)
    if changed_ingredient_names:
        for offset in range(0, len(changed_ingredient_names), 100):
            group = changed_ingredient_names[offset:offset + 100]
            placeholders = ",".join("?" for _ in group)
            for row in revised.execute(f"""
              SELECT c.ingredient_name,c.filter_id,f.domain,f.key,c.state,c.reason,c.evidence,c.method
              FROM ingredient_filter_classifications c JOIN filter_definitions f USING(filter_id)
              WHERE c.ingredient_name IN ({placeholders})
              ORDER BY c.ingredient_name,c.filter_id
            """, group):
                ingredient_filters[str(row["ingredient_name"])].append({
                    "filter_id": int(row["filter_id"]), "domain": row["domain"], "key": row["key"], "state": row["state"],
                    "reason": row["reason"], "evidence": row["evidence"], "method": row["method"]})

    # Full replacement sets include empty lists, so an old match cannot leak
    # through when a revised filter has no matching recipes.
    set_values: dict[str, list[int]] = {}
    axes = [(int(r[0]), str(r[1])) for r in revised.execute("""
      SELECT DISTINCT c.filter_id,d.domain FROM recipe_filter_classifications c
      JOIN filter_definitions d USING(filter_id) ORDER BY c.filter_id
    """)]
    for filter_id, _domain in axes:
        for state in ("yes", "no", "unknown"):
            set_values[f"{filter_id}:{state}"] = [int(r[0]) for r in revised.execute("""
              SELECT c.RecipeId FROM recipe_filter_classifications c
              WHERE c.filter_id=? AND c.state=? ORDER BY CAST(c.RecipeId AS INTEGER)
            """, (filter_id, state))]

    chunks: list[dict] = []
    def add_chunk(kind: str, chunk_id: int, document: object) -> None:
        encoded = compact(document)
        if len(encoded) > args.max_chunk_bytes:
            raise ValueError(f"{kind} chunk {chunk_id} exceeds max chunk size ({len(encoded)} bytes)")
        asset = gzip_write(args.output / f"{kind}-{chunk_id}.json.gz", encoded)
        chunks.append({"kind": kind, "chunkId": chunk_id, **asset})

    for chunk in sorted(all_recipe_chunks):
        bucket: dict[str, dict] = {}
        for rid, profile in profiles_by_chunk[chunk].items():
            patch: dict = {"filters": changed_filters[chunk].get(rid, []), "profile": profile}
            if rid in source_patch_by_chunk[chunk]:
                patch["source"] = source_patch_by_chunk[chunk][rid]
            bucket[rid] = patch
        add_chunk("recipes", chunk, bucket)

    ingredient_chunk_map: dict[str, int] = {}
    for chunk, offset in enumerate(range(0, len(changed_ingredient_names), 25)):
        names_in_chunk = changed_ingredient_names[offset:offset + 25]
        for name in names_in_chunk:
            ingredient_chunk_map[name] = chunk
        add_chunk("ingredients", chunk, {name: {"filters": ingredient_filters[name]} for name in names_in_chunk})

    set_chunk_map: dict[str, int] = {}
    set_buckets: list[dict[str, list[int]]] = []
    pending: dict[str, list[int]] = {}
    for key, ids in set_values.items():
        candidate = {**pending, key: ids}
        if pending and len(compact(candidate)) > args.max_chunk_bytes:
            set_buckets.append(pending)
            pending = {key: ids}
        else:
            pending = candidate
    if pending:
        set_buckets.append(pending)
    for chunk, bucket in enumerate(set_buckets):
        for key in bucket:
            set_chunk_map[key] = chunk
        add_chunk("sets", chunk, bucket)

    planning_buckets: list[list[list]] = []
    pending_vectors: list[list] = []
    for vector in planning_vectors:
        candidate = [*pending_vectors, vector]
        if pending_vectors and len(compact(candidate)) > args.max_chunk_bytes:
            planning_buckets.append(pending_vectors)
            pending_vectors = [vector]
        else:
            pending_vectors = candidate
    if pending_vectors:
        planning_buckets.append(pending_vectors)
    for chunk, bucket in enumerate(planning_buckets):
        add_chunk("planning", chunk, bucket)

    report_path = args.updated.with_suffix(".filters-report.json")
    build_report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.is_file() else {}
    all_counts = {table: int(revised.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]) for table in
                  ("metadata", "recipes", "ingredients", "reviews", "ingredient_product_connections",
                   "filter_definitions", "classification_runs", "ingredient_filter_subjects",
                   "ingredient_filter_classifications", "recipe_filter_classifications",
                   "recipe_filter_profiles", "recipe_ingredient_quality")}
    manifest = {
        "schemaVersion": 1, "revision": revision, "classifierVersion": str(new_run["classifier_version"]),
        "baseDatasetId": base_id, "recipes": counts["recipes"], "chunkWidth": args.chunk_width,
        "recipeChunks": sorted(all_recipe_chunks), "ingredientChunks": ingredient_chunk_map,
        "setChunks": set_chunk_map, "planningChunks": list(range(len(planning_buckets))),
        "ingredientNames": names, "definitions": new_defs,
        "coverage": build_report.get("coverage", {}), "sourceSha256": details.get("sourceMainSha256"),
        "classifierFilesSha256": code_hashes, "inventoryHash": inventory_hash,
        "recipeIdsSha256": recipe_ids_hash,
        "unchangedCounts": invariant_counts, "sourceCounts": all_counts,
        "changedRecipeAxes": changed_recipe_axes, "changedIngredientNames": len(changed_ingredient_names),
        "planningReadiness": readiness_manifest,
        "chunkCount": len(chunks), "estimatedRowsToWrite": len(chunks) + 1,
        "chunks": chunks, "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    manifest_path = args.output / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"manifest": str(manifest_path.resolve()), "revision": revision,
                      "baseDatasetId": base_id, "recipes": counts["recipes"],
                      "changedRecipeAxes": changed_recipe_axes, "changedIngredientNames": len(changed_ingredient_names),
                      "recipeChunks": len(all_recipe_chunks), "ingredientChunks": len(ingredient_chunk_map) and (len(changed_ingredient_names)+24)//25,
                      "setChunks": len(set_buckets), "planningChunks": len(planning_buckets),
                      "estimatedRowsToWrite": len(chunks)+1,
                      "uncompressedBytes": sum(x["uncompressedBytes"] for x in chunks)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
