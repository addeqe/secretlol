#!/usr/bin/env python3
"""Build the bounded, USDA-backed recipe amount conversion asset.

The food mapping is intentionally curated by exact USDA food description. This
script does not use the research pipeline's token-overlap matcher: selecting a
nearby food can silently apply the wrong preparation or density.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import zipfile
from collections import defaultdict
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ARCHIVE = ROOT.parent / "food_unit_reconstruction/data/reference/fdc_sr_legacy_2018-04.zip"
DEFAULT_REQUIREMENTS = ROOT / "ingredient-data/requirements.json"
DEFAULT_OUTPUT = ROOT / "src/meal-conversions-data.json"

# Each row records an intentionally narrow ingredient alias group, the exact
# source-food description, and why this mapping is considered equivalent for
# reference conversion. Source-food choices are never ranked or guessed.
FOOD_GROUPS: tuple[tuple[str, str, str, tuple[str, ...]], ...] = (
    ("169655", "Sugars, granulated", "Granulated white sugar; source entries are unqualified granulated sugar.", ("sugar", "white sugar", "granulated sugar", "caster sugar")),
    ("168833", "Sugars, brown", "Brown sugar; packed and unpacked portions remain separate and are not mixed.", ("brown sugar", "light brown sugar", "light-brown sugar", "dark brown sugar", "soft brown sugar")),
    ("169656", "Sugars, powdered", "Powdered/confectioners sugar; only unqualified teaspoon is published.", ("powdered sugar", "confectioners' sugar", "icing sugar")),
    ("173468", "Salt, table", "Table salt; coarse and sea salts are excluded because their volume density differs.", ("salt", "table salt", "iodized salt", "non-iodized salt")),
    ("173410", "Butter, salted", "Salted butter; reference mass density is shared with the source's unsalted butter entry.", ("butter", "salted butter", "sweet butter")),
    ("173430", "Butter, without salt", "Unsalted butter, matching explicit unsalted ingredient names.", ("unsalted butter",)),
    ("168894", "Wheat flour, white, all-purpose, enriched, bleached", "Standard all-purpose/plain white flour; specialty, bread, cake, and whole-grain flours are separate.", ("all-purpose flour", "all-purpose white flour", "plain flour", "plain white flour", "white flour", "unbleached flour", "unbleached all-purpose flour", "general purpose white flour")),
    ("168896", "Wheat flour, white, bread, enriched", "Explicit bread flour.", ("bread flour", "strong white flour", "white bread flour")),
    ("168893", "Wheat flour, whole-grain (Includes foods for USDA's Food Distribution Program)", "Explicit whole-wheat flour.", ("whole wheat flour", "whole-wheat flour")),
    ("169698", "Cornstarch", "Exact ingredient identity.", ("cornstarch", "corn starch")),
    ("168446", "Potato flour", "Exact ingredient identity; potato starch is deliberately excluded.", ("potato flour",)),
    ("175040", "Leavening agents, baking soda", "Exact baking-soda identity; duplicated half-teaspoon records are reduced to their equivalent per-unit value.", ("baking soda", "bicarbonate of soda")),
    ("172803", "Leavening agents, baking powder, double-acting, sodium aluminum sulfate", "Generic baking powder mapped to the USDA double-acting reference; all resulting conversions are marked approximate.", ("baking powder",)),
    ("171320", "Spices, cinnamon, ground", "Ground cinnamon only; cinnamon sticks are excluded.", ("ground cinnamon",)),
    ("171326", "Spices, nutmeg, ground", "Ground nutmeg only.", ("ground nutmeg",)),
    ("170926", "Spices, ginger, ground", "Ground ginger only; fresh ginger root is separate.", ("ground ginger", "ginger powder", "powdered ginger")),
    ("171325", "Spices, garlic powder", "Garlic powder only; raw garlic and dried garlic flakes/granules are separate.", ("garlic powder",)),
    ("171329", "Spices, paprika", "Paprika spice; no distinct smoked/hot variant is mapped.", ("paprika", "sweet paprika", "hot paprika")),
    ("170931", "Spices, pepper, black", "Ground black pepper only; peppercorns and coarse pepper are excluded.", ("black pepper", "ground black pepper", "fresh ground black pepper", "fresh ground pepper", "fresh black pepper")),
    ("170932", "Spices, pepper, red or cayenne", "Ground cayenne/red pepper powder only; unspecified cayenne and fresh peppers are excluded.", ("ground cayenne pepper",)),
    ("170923", "Spices, cumin seed", "Whole cumin seed only; ground cumin is excluded.", ("cumin seed", "cumin seeds")),
    ("170922", "Spices, coriander seed", "Whole coriander seed only; ground coriander is excluded.", ("coriander seed", "coriander seeds")),
    ("171321", "Spices, cloves, ground", "Ground cloves only; whole cloves are excluded.", ("ground cloves",)),
    ("171315", "Spices, allspice, ground", "Ground allspice only; unqualified allspice and berries are excluded.", ("ground allspice", "allspice powder")),
    ("172231", "Spices, turmeric, ground", "Ground turmeric only; unqualified turmeric is excluded because raw root and ground spice differ.", ("ground turmeric", "turmeric powder", "haldi powder")),
    ("171328", "Spices, oregano, dried", "Dried oregano only; fresh oregano is excluded.", ("dried oregano", "dry oregano", "dried oregano leaves", "dry oregano leaves")),
    ("171317", "Spices, basil, dried", "Dried basil only; fresh basil is excluded.", ("dried basil", "dry basil", "dried basil leaves", "dried leaf basil")),
    ("170938", "Spices, thyme, dried", "Dried thyme only; fresh thyme is excluded.", ("dried thyme", "dry thyme", "dried thyme leaves", "dry thyme leaves")),
    ("175043", "Leavening agents, yeast, baker's, active dry", "Active dry baker's yeast only; unspecified dry, instant, fresh/compressed yeast are excluded.", ("active dry yeast",)),
    ("169640", "Honey", "Honey; source provides direct cup/tablespoon measures.", ("honey", "liquid honey")),
    ("167747", "Lemon juice, raw", "Fresh/raw lemon juice; bottled/concentrated juice is a separate source food.", ("fresh lemon juice",)),
    ("167748", "Lemon juice from concentrate, canned or bottled", "Bottled/concentrated lemon juice only.", ("bottled lemon juice",)),
    ("167749", "Lemon peel, raw", "Raw lemon peel/zest; only matching source teaspoon/tablespoon measures are emitted.", ("lemon peel", "lemon rind", "lemon zest", "fresh lemon rind", "fresh lemon zest")),
    ("171413", "Oil, olive, salad or cooking", "Olive oil reference density; extra-virgin and generic olive oil use the same USDA oil class and are marked approximate.", ("olive oil", "extra virgin olive oil")),
    ("172336", "Oil, canola", "Canola oil reference density.", ("canola oil",)),
    ("169230", "Garlic, raw", "Raw garlic only; count measures are not exposed unless a named size is present (none here).", ("garlic", "fresh garlic")),
    ("170000", "Onions, raw", "Raw onion. Only size-specific count measures are emitted for an explicitly size-qualified name; prep-specific cup measures are withheld.", ("small onion", "small onions", "small yellow onion", "small red onion")),
    ("170393", "Carrots, raw", "Raw carrots. Count measures require explicit size; prep-specific cup measures are withheld.", ("small carrot", "small carrots", "medium carrot", "medium carrots", "large carrot", "large carrots")),
    ("170457", "Tomatoes, red, ripe, raw, year round average", "Raw tomatoes. Count measures require explicit size; cherry/plum forms remain distinct and prep-specific cup measures are withheld.", ("small tomato", "small tomatoes", "medium tomato", "medium tomatoes", "large tomato", "large tomatoes")),
    ("171287", "Egg, whole, raw, fresh", "Raw whole egg. Count weights are exposed only for an explicitly named USDA size.", ("large egg", "large eggs", "medium egg", "medium eggs", "small egg", "small eggs")),
    ("173944", "Bananas, raw", "Raw bananas. Count weights are exposed only for an explicitly named USDA size.", ("small banana", "small bananas", "medium banana", "medium bananas", "large banana", "large bananas")),
    ("169988", "Celery, raw", "Raw celery. Count weights require an explicitly size-qualified stalk name.", ("small celery stalk", "medium celery stalk", "large celery stalk")),
    ("173904", "Cereals, oats, regular and quick, not fortified, dry", "Dry regular/rolled oats; source cup is 81g. Generic `Oats` (FDC 169705, 156g/cup) is not used because its grain/preparation form is ambiguous.", ("rolled oats", "old fashioned oats", "old-fashioned oatmeal", "porridge oats")),
    ("172989", "Cereals, QUAKER, Quick Oats, Dry", "Explicit quick oats; source half-cup is 40g (80g/cup). Generic `Oats` is not used because its grain/preparation form is ambiguous.", ("quick oats", "quick-cooking oats")),
    ("171284", "Yogurt, plain, whole milk", "Plain whole-milk yogurt only.", ("plain whole-milk yogurt", "full-fat plain yogurt")),
    ("170886", "Yogurt, plain, low fat", "Plain low-fat yogurt only.", ("plain low-fat yogurt", "low-fat plain yogurt")),
    ("173442", "Sour cream, reduced fat", "Reduced-fat sour cream only; regular/fat-free remain unmapped.", ("reduced-fat sour cream", "light sour cream")),
    ("171247", "Cheese, parmesan, grated", "Explicitly grated Parmesan only; unspecified Parmesan and shredded Parmesan are not mapped.", ("grated parmesan", "grated parmesan cheese")),
)


def norm_name(value: str) -> str:
    return re.sub(r"\s+", " ", value.casefold().replace("&", "and")).strip(" ,.;:")


def read_csv(archive: zipfile.ZipFile, suffix: str) -> list[dict[str, str]]:
    name = next((n for n in archive.namelist() if n.endswith("/" + suffix)), None)
    if not name:
        raise ValueError(f"USDA SR Legacy archive missing {suffix}")
    with archive.open(name) as raw:
        return list(csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")))


def parse_measure(row: dict[str, str], unit_names: dict[str, str]) -> tuple[str, str] | None:
    # SR Legacy often records measure_unit as "undetermined" and stores the
    # meaningful amount in modifier, so retain and parse the raw modifier.
    descriptor = re.sub(r"\s+", " ", (row.get("modifier") or "").strip().casefold())
    descriptor = descriptor.removeprefix("1 ").strip()
    if not descriptor:
        descriptor = (unit_names.get(row.get("measure_unit_id", ""), "") or "").casefold().strip()
    # Accept only unqualified volume measures. Qualifiers such as chopped,
    # sliced, packed, sifted, whipped, or mashed require matching prep context.
    if descriptor in {"cup", "cups"}:
        return "cup", descriptor
    if descriptor in {"tbsp", "tablespoon", "tablespoons"}:
        return "tablespoon", descriptor
    if descriptor in {"tsp", "teaspoon", "teaspoons"}:
        return "teaspoon", descriptor
    size_match = re.match(r"^(small|medium|large)\b", descriptor)
    if size_match:
        return "count", size_match.group(1)
    stalk_match = re.match(r"^stalk,\s*(small|medium|large)\b", descriptor)
    if stalk_match:
        return "count", stalk_match.group(1)
    return None


def build(archive_path: Path, requirements_path: Path) -> tuple[dict[str, Any], dict[str, int]]:
    with zipfile.ZipFile(archive_path) as archive:
        food_rows = read_csv(archive, "food.csv")
        unit_rows = read_csv(archive, "measure_unit.csv")
        portion_rows = read_csv(archive, "food_portion.csv")

    foods = {str(row["fdc_id"]): row["description"] for row in food_rows}
    unit_names = {row["id"]: row["name"] for row in unit_rows}
    requirements_doc = json.loads(requirements_path.read_text())
    requirements = {norm_name(row["name"]): row for row in requirements_doc.get("requirements", [])}

    alias_specs: dict[str, tuple[str, str, str]] = {}
    for fdc_id, expected_description, rationale, aliases in FOOD_GROUPS:
        actual = foods.get(fdc_id)
        if actual != expected_description:
            raise ValueError(f"USDA food mismatch for FDC {fdc_id}: expected {expected_description!r}, got {actual!r}")
        for alias in aliases:
            key = norm_name(alias)
            spec = (fdc_id, expected_description, rationale)
            if key in alias_specs and alias_specs[key] != spec:
                raise ValueError(f"Ingredient alias has conflicting curated matches: {alias!r}")
            alias_specs[key] = spec

    portions_by_food_unit: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in portion_rows:
        fdc_id = str(row.get("fdc_id", ""))
        if fdc_id not in {spec[0] for spec in alias_specs.values()}:
            continue
        parsed = parse_measure(row, unit_names)
        if parsed is None:
            continue
        unit, measure = parsed
        try:
            basis = float(row.get("amount") or 1)
            grams = float(row.get("gram_weight") or 0)
        except ValueError:
            continue
        if basis <= 0 or grams <= 0:
            continue
        grams_per_unit = grams / basis
        # For count, unit is returned only if a requested ingredient name has
        # the same explicit USDA size. Volume entries are limited to exact,
        # unqualified source measures.
        evidence = {
            "measure": measure,
            "portionDescription": row.get("portion_description") or "",
            "sourceModifier": row.get("modifier") or "",
            "amountBasis": basis,
            "gramWeight": grams,
            "gramsPerUnit": round(grams_per_unit, 5),
        }
        portions_by_food_unit[(fdc_id, unit)].append(evidence)

    source_foods: dict[str, Any] = {}
    out: dict[str, int] = {}
    mapped_names = set()
    mapped_occurrences = 0
    for alias, (fdc_id, description, rationale) in sorted(alias_specs.items()):
        # This is a Worker asset for the current corpus contract. Keep its
        # alias table scoped to actual canonical ingredient names, while
        # retaining the explicit mappings in FOOD_GROUPS for regeneration.
        if alias not in requirements:
            continue
        units: dict[str, Any] = {}
        for unit in ("cup", "tablespoon", "teaspoon", "count"):
            evidences = [entry for entry in portions_by_food_unit.get((fdc_id, unit), []) if entry["measure"] in ("small", "medium", "large") or unit != "count"]
            permitted_sizes = {size for size in ("small", "medium", "large") if re.search(rf"\b{size}\b", alias)} if unit == "count" else set()
            if unit == "count":
                evidences = [entry for entry in evidences if entry["measure"] in permitted_sizes]
            # A source portion for one full unit is a more reliable basis than
            # a rounded fractional label such as 0.33 cup; use fractions only
            # where USDA supplies no direct 1-unit portion (for example 0.5
            # cup of branded quick oats).
            if unit != "count" and any(entry["amountBasis"] == 1 for entry in evidences):
                evidences = [entry for entry in evidences if entry["amountBasis"] == 1]
            if not evidences:
                continue
            # A unit with distinct measures cannot be resolved from ingredient
            # name + unit alone; withhold it. Repeated duplicate records with
            # equal grams are safely collapsed but all supporting measures are
            # retained as evidence.
            values = {entry["gramsPerUnit"] for entry in evidences}
            if len(values) != 1:
                continue
            grams_per_unit = next(iter(values))
            conversion = {
                "gramsPerUnit": grams_per_unit,
                "measure": evidences[0]["measure"],
                "sourceMeasures": evidences,
                "approximate": True,
                "uncertaintyPercent": 20,
            }
            if unit == "count":
                units.setdefault("count", {})[conversion["measure"]] = conversion
            else:
                units[unit] = conversion
        if not units:
            continue
        source = source_foods.setdefault(fdc_id, {
            "description": description,
            "mappingMethod": "curated-exact-food-equivalence",
            "mappingRationale": rationale,
            "conversions": {},
        })
        for unit, conversion in units.items():
            if unit == "count":
                source["conversions"].setdefault("count", {}).update(conversion)
            else:
                source["conversions"].setdefault(unit, conversion)
        out[alias] = int(fdc_id)
        req = requirements.get(alias)
        if req:
            mapped_names.add(alias)
            mapped_occurrences += int(req.get("occurrences", 0))

    archive_sha = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    source = {
            "name": "USDA FoodData Central SR Legacy",
            "release": "April 2018",
            "archiveSha256": archive_sha,
            "license": "CC0 1.0",
            "citation": "U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, SR Legacy April 2018. https://fdc.nal.usda.gov/",
            "uncertaintyPolicy": "All reference conversions are approximate and carry a conservative ±20% planning allowance; the USDA source does not publish uncertainty bounds for food portions.",
        }
    revision_material = json.dumps({"source": source, "foods": source_foods, "ingredients": out}, sort_keys=True, separators=(",", ":")).encode()
    asset_revision = f"usda-sr-2018-{hashlib.sha256(revision_material).hexdigest()[:12]}"
    dataset = {
        "schemaVersion": 1,
        "revision": asset_revision,
        "source": source,
        "foods": source_foods,
        "ingredients": out,
    }
    stats = {
        "requirementNames": len(requirements),
        "requirementOccurrences": sum(int(row.get("occurrences", 0)) for row in requirements.values()),
        "mappedNames": len(mapped_names),
        "mappedOccurrences": mapped_occurrences,
        "assetEntries": len(out),
        "revision": asset_revision,
        "volumeEntries": sum(sum(1 for unit in entry["conversions"] if unit != "count") for entry in source_foods.values()),
        "countEntries": sum(len(entry["conversions"].get("count", {})) for entry in source_foods.values()),
    }
    return dataset, stats


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, default=DEFAULT_ARCHIVE)
    parser.add_argument("--requirements", type=Path, default=DEFAULT_REQUIREMENTS)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    asset, stats = build(args.archive, args.requirements)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(asset, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({**stats, "output": str(args.output)}, indent=2))


if __name__ == "__main__":
    main()
