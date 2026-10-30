# Produktbaserad receptnäring – lokalt utvecklingsflöde

Status 2026-10-14. Produktetiketten för det godkända produkt-ID:t är primär.
Ett valfritt, lokalt och versionslåst generiskt livsmedelsunderlag kan fylla
kompatibla luckor som en tydligt märkt uppskattning. Butikens fakta och
generiska uppskattningar hålls åtskilda i utdata. Flödet är inte godkänt för
massimport eller publicering; den gamla stora receptdatabasen är oförändrad.

## Vad som är byggt och provat

- Coops befintliga produktanrop bevarar nu råa näringsfält och måttbas.
  Checkpoints behåller dem också. Äldre produktposter utan fälten fungerar.
- En begränsad insamlare hämtar endast redan godkända produkt-ID:n till en
  ny lokal fil. Ändrad produktidentitet spärras; andra produkter fortsätter.
- En separat SQLite-cache behåller etikettversioner, originalfält och
  receptberoenden. Pris/tidsstämpel ingår inte i etikettens innehållshash.
- Normaliseringen läser svenska näringsnamn, gram/ml, decimaler och `<`.
  Explicit tillagad deklaration kan inte skrivas över som såld vara.
- Beräkningen verifierar kedja, produkt-ID, etikettversion och mängdens
  livsmedelsform. Den behåller näringsvärden var för sig och hittar aldrig
  på nollor, gramvikter eller portionsantal.
- Felaktiga recept isoleras i en granskningslista med originalposten.
  Receptberoenden uppdateras tillsammans i en transaktion, med kontroll
  att etikettuppsättningen inte har ändrats under beräkningen.
- Ett avgränsat källflöde kör parser, mängdbelägg, OFF-allergener, befintliga
  halalregler, portionsparser och Willys-koppling direkt från ett sparat
  RecipeNLG-urval. Resultaten lagras även i ett
  separat normaliserat arbetslager med atomisk sparning per recept.
- `audit` kan få `--reference-cache` för valfria generiska uppskattningar.
  Godkänd produktidentitet, matchad mängd och spärrar är fortsatt krav.
  Butikens primärvärden behålls; referensen fyller bara kompatibla saknade
  näringsfält och lagras med egen källa, FDC-ID och innehållshash.
- `source_choices` verifierar själv mängden för ett uttryckligt första
  komplett alternativ eller ett parserstyrt intervalls övre ändpunkt.
  Ursprungstext och källbelägg bevaras. Övriga alternativ och mängder som inte
  kan verifieras lämnas olösta.

## Historiskt testresultat: Coop-etiketterna

Följande siffror beskriver den daterade hämtningen 2026-10-13 och är inte
aktuella täckningslöften. Se [insamlingsrapporten](../data/recipe-ingestion-quality/architecture-reset/coop-labels-approved-live.json), [importresultatet](../data/recipe-ingestion-quality/architecture-reset/coop-label-import-v2.json) och [etikettgranskningen](../data/recipe-ingestion-quality/architecture-reset/coop-label-quality-v2.json).

Alla **376** tidigare godkända produkt-ID:n efterfrågades i **16** läsanrop.
Ingen Cloudflare-skrivning gjordes.

| Resultat | Antal |
| --- | ---: |
| Produktsvar med bevarade näringsfält | 372 |
| Tydlig näringsdeklaration och måttbas | 287 |
| Tomma/otillräckliga fält, exempelvis bara `nutrientBasis: {}` | 85 |
| Produkten saknades | 3 |
| Produktidentiteten hade ändrats och spärrades | 1 |
| Deklaration med exakt protein, fett och kolhydrater | 268 |
| Deklaration med exakt fiber | 129 |

264 deklarationer gäller gram och 23 gäller ml. Två uttryckligen gäller
tillagad vara. Saknade fält är okända. De 17 deklarationer som endast anger
0 kcal och 0 kJ, utan makronäring, spärras för energimål tills uppgifterna
har kontrollerats; deras ursprungliga uppgifter finns kvar.

Råmaterial och rapporter finns under
`data/recipe-ingestion-quality/architecture-reset/`:

- `coop-labels-approved-live.json`: insamlingen och godkännandekontrollerna.
- `coop-label-import-v2.json`: normaliseringsresultat, luckor och revisioner.
- `product-labels-v2.sqlite`: den nya separata etikettcachen.
- `coop-label-quality-v2.json`: kontroll av etiketternas interna uppgifter.

Detta är täckningen bland de godkända Coop-produkterna, inte bland hela sortimentet.

## Beräkning och viktiga gränser

Det historiska beräkningstestet med 150 ml havredryck gav
90 kcal och 1,5 g protein: deklarationens värde multipliceras med 150/100.
Saknat fiber eller kolesterol blir fortfarande okänt. Salt kan omräknas
till natrium enligt deklarationsdefinitionen, med separat källbelägg.

Gram får inte räknas som ml. Styckantal och volym kräver en godkänd fysisk
referens eller en SKU-bunden produktomräkning. Generiska portionsvikter får
inte låna en butikskontext och blir inte prisbevis. Ospecificerade burkar
förblir paket; svensk förpackningsstorlek får inte fylla en okänd burkvikt.

Etiketten och mängden måste dessutom avse samma tillstånd, till exempel
före beredning respektive efter beredning. `nutritionContext` innehåller
separata källbelägg för detta. Okända tillstånd härleds inte från varunamnet.
Frityrolja, bortkastad marinad och avrunnen kokvätska har fortfarande
osäker faktisk konsumtion även om produktetiketten är fullständig.

Okända portioner tillåter totalsummor för hela receptet. En tydlig styck-yield
ger även näring per styck, exempelvis per kak-kluster, utan att kallas portioner.
Okända portioner tillåter inte
att ett godtyckligt portionsantal används i ett näringsmål.

## Avgränsade lokala kommandon

Bygg vid behov en lokal referensfil en gång från den redan nedladdade USDA-
databasen och granskade aliasen. Det här kommandot processar inga recept:

```bash
data/recipe-ingestion-venv/bin/python offline/product_recipes.py build-references \
  --output data/NEW-commodity-references.json
```

Använd den sedan valfritt vid en avgränsad granskning:

```bash
data/recipe-ingestion-venv/bin/python offline/product_recipes.py audit \
  --input path/to/bounded-recipes.jsonl \
  --labels data/NEW-product-labels.sqlite \
  --output data/NEW-product-audit \
  --count 50 --seed 20261013 \
  --reference-cache data/NEW-commodity-references.json
```

Utan `--reference-cache` finns ingen generisk reservväg. Per recept görs inga
LLM-anrop, nätverksanrop eller USDA-frågor; referensfilen läses lokalt.
Referenser skapar inte godkända SKU:n och kan inte kringgå produkt-, form-,
halal- eller prisgrindar. De bidrar inte med aktuellt butikspris.

Förbered 50 råa källrecept ur ett tidigare sparat slumpurval, utan den gamla
USDA-importen. Kommandot skapar `work.sqlite`, `recipes.jsonl`, `report.json`
och en granskningslista i en ny mapp:

```bash
data/recipe-ingestion-venv/bin/python offline/product_recipes.py prepare-sample \
  --input path/to/frozen-raw-sample.json \
  --output data/NEW-source-sample --count 50 --seed 20261013 \
  --volume-system us_customary
```

Urvalsfiler skapas av det befintliga `recipes.py sample` och innehåller
originalrader samt datasetets hash. Detta steg läser det sparade urvalet;
det startar ingen ny genomgång av hela CSV-filen.

Insamling är offline som standard. Den här varianten läser enbart redan
bevarade etiketter och skriver en ny fil:

```bash
node scripts/collect-product-nutrition.ts \
  --input data/coop-reviewed-dataset-20261009.json \
  --output data/NEW-coop-label-collection.json \
  --max-products 25
```

`--allow-live` hämtar saknade etiketter för de valda godkända ID:na från
Coop. Det kräver den befintliga offentliga Coop-nyckeln i miljön. Ett
uttryckligt anrops- och produktantal begränsar körningen. Utdata skrivs
aldrig över. Detta gör ingen butiksscan och använder inte D1.

Importera en insamlingsfil till en separat etikettcache:

```bash
data/recipe-ingestion-venv/bin/python offline/product_recipes.py import-labels \
  --input data/NEW-coop-label-collection.json \
  --labels data/NEW-product-labels.sqlite \
  --report data/NEW-product-label-import.json
```

Granska 50 slumpmässigt valda poster ur en tidigare avgränsad receptartefakt:

```bash
data/recipe-ingestion-venv/bin/python offline/product_recipes.py audit \
  --input path/to/bounded-recipes.jsonl \
  --labels data/NEW-product-labels.sqlite \
  --output data/NEW-product-audit \
  --count 50 --seed 20261013
```

Detta läser befintliga produktkopplingar, inte gamla näringsvärden.
Det genererar `report.json`, `recipes.jsonl` och `review-list.json`.
`--contexts` kan ange redan granskade mät-/etikettkontexter per recept och
ingrediensindex. `--volume-system us_customary` krävs för att tillåta
den måttstandardens koppar/skedar. Ingen masskörning finns i denna CLI.

## Uppdateringar

Samma näringshash med nytt observationstillfälle uppdaterar färskheten och
lämnar receptberoendena orörda. En annan etikettversion ger en lista över
just de recept som använder den tidigare versionen. Recept som väntar på
en saknad etikett registreras också, så att de hittas när etiketten anländer.
Ändrat valt produkt-ID kräver ny produkt- och formkontroll.

En regeländring som påverkar normaliseringen behöver en ny cacheversion
eller en uttrycklig migrering. Gamla, inkompatibla normaliseringsresultat
får inte återanvändas tyst. Cloudflare-flödet måste driftsättas separat;
den här lokala ändringen ändrar inte automatiskt det redan publicerade API:t.

## Daterade körningar och kvarvarande arbete

En tidigare kontroll omfattade 242 godkända Python-tester, 141 godkända
återförsäljartester och TypeScript-kontroll. Två olika urval med
50 råa källrecept har gått igenom utan tekniskt avbrott, nätverksanrop eller
USDA-databas. Inget av dessa 100 recept har ännu klarat hela kedjan:
produktkopplingarna, fysiska mängdomräkningar och rätt kedjas etiketter
är fortfarande ofullständiga. Att ett urval går att bearbeta är inte ett
godkännande för matplanering.

Den daterade kompaktformatkontrollen jämförde en 1 000-receptartefakt med
kompaktformat v3 och verifierade återläsning. I den prototypkörningen var
databasfilerna 60 MB respektive 40 MB; se [v4-körningsrapporten](../data/recipe-ingestion-quality/architecture-reset/coop-source-dev1000-v4/report.json). Det är en
lokal formatjämförelse, inte en prognos för hela den gamla databasen.

Willys lokala katalog saknar näringsetiketter. Officiella produktsidor
visar att uppgifterna finns, men någon automatisk detaljkälla med verifierat
JSON-format har ännu inte fastställts. Ett Willys-ID får inte behandlas
som ett Coop-ID för att få ett näringsvärde.

Det första kontrollurvalet med 50 äldre receptkopplingar gav därför inga
nya näringskompletta recept: kopplingarna var Willys-ID:n och den nya
etikettcachen innehåller Coop-ID:n. Rapporten påstår inte att detta är löst.
De nya körningarna med referenser och verifierade källval ska granskas via
[referensrapporten](../data/recipe-ingestion-quality/architecture-reset/product-source-dev1000-pending-20261014/reference-nutrition/report.json)
och [uppdaterad val-/mjölkrapport](../data/recipe-ingestion-quality/architecture-reset/product-source-dev1000-pending-20261014/reference-choices-milk-fixed/report.json).
Rapporterna är pågående utvecklingsresultat och kan ändras; använd dem som
underlag, inte som frysta täckningssiffror. Kvar står verifierad Willys-källa
eller separat godkänd Coop-koppling, bättre mängd-/formreferenser och ett nytt
orört kontrollurval. Massimporten ska förbli spärrad tills hela kedjan är
verifierad.
