# Lokal portions- och utbytesparser

Parsern är integrerad i den lokala receptimporten. Den läser portionsmetadata,
rubrik och instruktioner och sparar belägget för varje antal. Ingen ny modell
tränas och inga LLM- eller nätverksanrop görs vid extraktionen.

## Portioner och styckantal är olika fält

För användarens exempel `drop and shape into 30 clusters` blir resultatet:

```json
{
  "servings": null,
  "yield": {
    "amount": 30,
    "unit": "cluster",
    "source_unit": "clusters",
    "normalized_unit": "pieces",
    "source": "preparation_text"
  },
  "nutrition_divisor": 30,
  "nutrition_basis": "piece",
  "nutrition_unit": "cluster"
}
```

Detta är ett utdrag; den fulla posten innehåller bland annat intervallgränser,
regel, instruktionsindex och textbelägg. `nutrition.perYieldUnit` kan innehålla
hela receptets näring delat med 30. `nutrition.perServing` och `RecipeServings`
förblir `null`. Om ett näringsämne saknas i totalen är det också `null` per styck.
Delaren löser alltså inte ofullständiga USDA-kopplingar.

Om källan anger både 24 kakor och 12 personportioner sparas båda uppgifterna.
Personportionen är den primära näringsbasen, och näring per kaka sparas separat.
Hela pajer kan vara ett styckutbyte; två pajer betyder inte två personer.

Lagringen innehåller `portioning`, `source.RecipeYield`,
`source.RecipeServings`, `nutrition.perYieldUnit`, `nutrition.yieldUnit`,
`nutrition.nutritionDivisor` och `nutrition.nutritionDivisorBasis`.
Profilen innehåller också `nutrients_per_yield_unit` och `yield_unit`.
De befintliga per-portion-fälten får aldrig näring per kaka eller per hel paj.

## Vad reglerna stödjer

- Metadata: numeriska `servings`/`RecipeServings`, typade `recipeYield`,
  textlistor och objekt med `value`/`unitText`. Ett otypat `recipeYield: 30`
  säger inte om det gäller personer eller stycken.
- `Serves 4`, `Makes eight 1 cup servings`, `Yield: 4 to 6 servings`.
- `shape into 30 clusters`, `form 8 patties`, `cut into 18 bars`,
  `divide among 6 deep 2-cup soup bowls`, `5 rather large and thick burgers`.
- Dussin, tal skrivna med ord, bråktal för volym, ungefärliga antal och intervall.
  `Makes four dozen` kan få enheten från en entydig kakrubrik; regeln sparas.
- Utbytesetikett som ligger på raden före antalet: `Yield:` + `18 servings`.
- Volymutbyte, exempelvis 3½ koppar, med separat normaliserad volym i ml.
  Amerikanska receptmått används här precis som i ingrediensimporten.

`status` är `exact`, `range`, `approximate`, `conflict` eller `unknown`.
Ungefärliga antal och intervall används inte som exakta näringsdelare. En separat,
exakt personuppgift kan fortfarande användas när volymutbytet är ungefärligt.
Motstridiga uppgifter spärrar automatisk division och bevaras som belägg.

Skydden skiljer bland annat mellan minuter, temperatur, formstorlek,
ingrediensbitar, muffinsformar, smörportioner, alternativa satser och slutligt
receptutbyte. Om ett recept först formas till två rullar och sedan skivas utan
antal sparas två rullar som batchutbyte, men ingen per-styck-delare används.

Parsern härleder inte personportioner från kalorier, totalvikt, en ensam mugg
eller mängden råvaror. Indirekt montering av exempelvis fyra smörgåsar från
åtta brödskivor kräver fortfarande en framtida separat regel. Ett källvärde som
`1 3/4 servings` sparas som avvisat belägg för granskning. `unknown` betyder att
parsern inte säkert löste antalet, inte att källan bevisligen saknar information.

Portionsantal är frivilligt i den lokala importen, enligt beslut 2026-10-11.
`ready` kräver fortfarande godkänd halalpolicy, godkända inköpskopplingar och
mängder samt komplett näring för hela receptet. Ett saknat personantal ger
varningen `servings_unresolved` och hindrar inte inkludering. `RecipeServings`
och näring per portion förblir då `null`; appen kan använda hela receptets
näring och eventuellt kända styckantal. En fördelning måste anges innan appen
kan räkna per person. Hela receptets näring finns också i profilfältet
`nutrition_metrics.nutrients_recipe_total`. Detta arbete ändrar inte moln-API:t
eller den aktiva databasen.

## Provresultat, 2026-10-11

Sex likformiga stickprov om 50 recept från samma CSV, utan innehållsfilter,
har kontrollerats vara åtskilda. Ursprungliga urvalet återanvänds. Alla sex
omgångar bidrog till förbättringarna och ska betraktas som utvecklingsdata,
även om äldre lokala filnamn innehåller `holdout`, `validation` eller `frozen`.
Resultaten är extraktionsantal, inte en uppmätt korrekthetsprocent för datasetet.

| Slumpfrö | Recept | Exakta personportioner | Användbar exakt näringsdelare | Typat utbyte | Olöst |
| --- | ---: | ---: | ---: | ---: | ---: |
| 20261011, ursprungligt | 50 | 4 | 6 | 9 | 41 |
| 20261012 | 50 | 5 | 6 | 9 | 41 |
| 20261013 | 50 | 0 | 0 | 3 | 47 |
| 20261014 | 50 | 2 | 6 | 6 | 44 |
| 20261015 | 50 | 2 | 4 | 4 | 46 |
| 20261016 | 50 | 1 | 4 | 5 | 45 |
| **Totalt** | **300** | **14** | **26** | **36** | **264** |

De 26 delarna gäller 14 personantal och 12 styckantal. Övriga kända utbyten
omfattar intervall, ungefärliga antal, volymer och rullar som senare skivas.
`exact` på ett volymutbyte betyder inte att ett personantal är känt.

I de ursprungliga 50 recepten hittade den tidigare kontrollen tre exakta
personantal. Den nya hittar fyra, plus två användbara styckantal: 18 bars och
9 balls. Därutöver sparas två intervall och ett batchantal som senare skivas.
Det ger nio recept med typat utbyte, men bara sex med exakt användbar delare.

Förbättringarna efter nya omgångar omfattade `serving 6`, utelämnad enhet efter
dussin, bråkvolymer, beskrivande ord före antalets enhet, skålstorlek, delade
etikettrader och pajdiameter. Ett fel där fyra smörbitar blev fyra personportioner
upptäcktes och spärrades. Alternativet `For 4 servings ... using ...` räknas inte
som portionsantal för receptets ursprungliga ingredienslista.

42 sparade kontroller av källbelägg, inklusive de 36 utbytena och sex olösta
gränsfall, stämmer efter förbättringarna. Dessa kontroller gjordes under
utvecklingen; de är inte en oberoende mänsklig granskning eller ett orört testurval.
34 automatiska testmetoder täcker dessutom bland annat division, negativa fall,
konflikter, cache och integration med ingredienser/näring. Fullimporten av
2 231 142 recept har inte körts.

I ursprungsurvalet kvarstår noll helt importklara recept: det finns fortfarande
olösta närings- och inköpsmängder. Portionsparsern åtgärdar inte dessa separata
brister.

Hela den lokala importkedjan kördes också på ursprungliga 50 och nästa 50:
9 typade utbyten och 6 användbara delare i vardera omgången. Personantalet var
4 respektive 5. Inget recept fick komplett näring per styck. En omkörning av
ursprungsurvalet gav byte för byte identisk JSONL; SHA-256 var
`1d506f617d4c6fd676f046ad58c597919cc95282d512fcd1c8db007a2da69183`.
Importresultaten finns lokalt under `data/recipe-yield-tests/` och dessa
provkörningar gjorde noll LLM-anrop, nätverksanrop och produktionsskrivningar.

## Varför ingen modellträning nu?

Min bedömning är att regler är det bättre första steget här: de ger kort
körtid, spårbara beslut och kräver inga nya träningsetiketter. Den befintliga
ingredient-parser-modellen är gjord för ingrediensrader. Dess etiketter beskriver
bland annat mängd, enhet, namn och beredning; de skiljer inte personportioner från
slutligt receptutbyte och mellanled i en instruktion.
[Ingredient-parsers träningsdata](https://ingredient-parser.readthedocs.io/en/latest/explanation/data.html).

Träningsramverket använder en CRF och kan i princip återanvändas för en separat
modell. Det kräver ett nytt representativt, märkt material av instruktioner,
negativa exempel, andra etiketter och utvärdering på avskilda receptfamiljer.
En sådan modell behöver fortfarande regler för antal, typ, konflikter och
näringsdivision. Den kan inte återställa portionsuppgifter som aldrig angavs.
[Träningsdokumentationen](https://ingredient-parser.readthedocs.io/en/latest/explanation/training.html).

De aktuella stickproven kan bli underlag för framtida märkning, men reglernas
egna svar ska inte användas som ett oberoende facit. Inga träningsverktyg eller
nya modellberoenden har installerats för detta arbete.

## Reproducera

Från projektets katalog, med vanlig Python för själva portionsutvärderingen:

```bash
python3 offline/evaluate_yields.py \
  --samples \
  data/recipe-ingestion-resources/random-50-seed20261011.json \
  data/recipe-ingestion-resources/yield-holdout-50-seed20261012.json \
  data/recipe-ingestion-resources/yield-validation-50-seed20261013.json \
  data/recipe-ingestion-resources/yield-final-50-seed20261014.json \
  data/recipe-ingestion-resources/yield-frozen-50-seed20261015.json \
  data/recipe-ingestion-resources/yield-heldout-50-seed20261016.json \
  --output data/recipe-yield-tests/evaluation \
  --audit offline/assets/yield-sample-audit.json \
  --baseline data/recipe-ingestion-sample/v1/run-a/recipes.jsonl

data/recipe-ingestion-venv/bin/python -m unittest discover -s offline -p 'test_*.py' -v
```

Utvärderingen sparar `report.json` och `yields.jsonl`, med version, kodhash,
datasetets hash, urvalens hash och samtliga textbelägg. Den kontrollerar även
överlapp mellan urval och avvikelser från de sparade kontrollerna. Ursprungliga
resultatfiler har behållits för före/efter-jämförelsen.
