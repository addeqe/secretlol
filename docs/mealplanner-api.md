# Måltidsplanerarens moln-API

Basadress: https://willys-catalog.abowlena.workers.dev

Alla data för den godkända receptsamlingen finns i Cloudflare D1 efter den femte importetappen. Appen behöver inte läsa någon lokal SQLite-fil. Receptinnehåll och klassificeringar ligger i databasen `mealplanner-recipes`; produkter, prisversioner och aktuella ingredienskopplingar ligger i `willys-catalog`. En och samma API-tjänst läser båda.

## Autentisering

Skicka `Authorization: Bearer <PRICE_API_TOKEN>` från appens backend. Använd samma privata API-token som tidigare. Spara token som en miljöhemlighet hos backendens molnleverantör. Token ska inte finnas i frontendkod, GitHub-repot eller en offentlig URL. För installationsägaren finns anslutningsvärdena också i den befintliga privata `data/mealplanner.env`; appen behöver inte läsa den filen.

## Innehåll

Samlingen innehåller 15 244 recept, 96 082 ingrediensförekomster, 881 unika ingrediensnamn, 60 494 bevarade recensioner, 171 filterdefinitioner och alla ursprungliga klassificerings-, närings-, mängd- och källuppgifter. Recepten följer det redan godkända urvalet och köttpolicyn. Historiska kopplingar i receptarkivet är källbevis; appen ska använda `ingredients[].connection` eller offertens produkt-ID för aktuella kopplingar/priser.

## Uppladdningen

`Import meal database over five days` är en tillfällig GitHub Actions-workflow. Den laddar högst en etapp per UTC-dag från den låsta GitHub-releasen `meal-data-2026-10-07`. Första etappen innehåller 3 049 recept och hela ingredienslistan/filterdefinitionerna; etapp 2–4 innehåller vardera 3 049 recept och etapp 5 innehåller 3 048.

Kontrollsummor verifieras före varje import. Redan importerade dokument skrivs inte om vid omkörning. Vid avbrott återupptas samma etapp; nästa etapp kan inte avslutas samma UTC-dag. Alla slutliga recept-, ingrediens- och recensionsantal kontrolleras innan databasen görs tillgänglig för sökning. Workflowen stänger av sig själv efter slutförd import. Recept-API:t svarar `503 recipe_import_in_progress` under importen; `/meal/status` visar framstegen.

Cloudflares gräns 100 000 skrivna rader/dag gäller hela kontot, inklusive index och raderingar. Den kompakta dokumentlagringen kräver ungefär 4 200 skrivningar första etappen och 3 100 för senare etapper. Uppladdningen kontrollerar kontots rapporterade dagsförbrukning, reserverar marginal och delar en kö med kataloguppdateringen. Andra program på samma konto kan påverka tillgänglig kvot. Vid kvotbrist eller ett GitHub/Cloudflare-avbrott förskjuts en etapp tills en lyckad körning kan ske; dag 5 avser fem lyckade dagsetapper.

Den exakta SQLite-filen finns komprimerad som GitHub-releasebilaga. Kontrollsumman för den uppackade filen finns i manifestet. GitHub används för arkiv och installationsunderlag; vanliga API-anrop hämtar all information från Cloudflare.

## Tillgängliga anrop

| Anrop | Innehåll |
|---|---|
| `GET /meal/status` | Importstatus, antal och aktuella databas-, katalog- och kopplingsversioner |
| `GET /meal/openapi.json` | API-beskrivning för integration |
| `GET /meal/dataset` | Release-manifest, källmetadata, klassificeringsversioner och arkivlänk |
| `GET /meal/filters` | Alla filter med svenska/engelska etiketter, nycklar och förklaringar |
| `GET /meal/recipes` | Sökning, filter och paginering |
| `GET /meal/recipes/123` | Recept, instruktioner, bilder, näring, ingrediensmängder, filterbevis och aktuella produktkopplingar |
| `GET /meal/recipes/123/reviews?limit=20&offset=0` | Recensioner med paginering |
| `GET /meal/recipes/123/archive` | Komplett ursprungsdokument, inklusive recensioner och bevarade källbevis |
| `GET /meal/recipes/123/cost?servings=4` | Kostnadsunderlag och inköpslista för ett recept |
| `POST /meal/quote` | Gemensam kostnadsberäkning/inköpslista för flera recept |
| `GET /meal/ingredients?limit=50` | Ingrediensklassificeringar och aktuella Willys-kopplingar |
| `GET /meal/ingredients/archive?name=eggs` | Komplett klassificerings- och kopplingsbevis från ursprungsdatabasen; historiska priser används inte som aktuella |
| `POST /meal/ingredients/lookup` | Samma information för upp till 100 exakta ingrediensnamn |
| `GET /status` | Katalogens aktualitet och butik |
| `GET /products/PRODUCT_ID` | Produktens aktuella pris, erbjudanden och paketuppgifter |
| `GET /history/PRODUCT_ID` | Bevarade prisändringar |

### Söka och filtrera

Exempel:

```text
/meal/recipes?diet=vegetarian&excludeAllergen=milk,peanuts&cuisine=mexican&mealType=breakfast&limit=20
```

Tillåtna parametrar är `q`, `diet`, `excludeAllergen`, `cuisine`, `region`, `mealType`, `taste`, `nutrition`, `availableOnly`, `limit` och `cursor`. Använd filter-`key` från `/meal/filters`. `q` söker i recepttiteln. Dieter, uteslutna allergener och näringsfilter kombineras med OCH. Flera cuisines/regioner/rätttyper/smaker kombineras med ELLER inom respektive kategori, och OCH mellan kategorierna. Till exempel betyder `cuisine=mexican,lebanese` mexikansk eller libanesisk.

Allergi- och kostfilter har `yes`, `no` eller `unknown`. Ett allergen måste ha `no` för att ett recept ska passera `excludeAllergen`. En diet måste ha `yes`. Okända bedömningar släpps inte igenom strikta filter. Namnbaserade filter verifierar inte produktetiketter eller spår av allergener. Näringsdata kommer från källans uppgifter per portion och delas inte en andra gång med portionsantalet. LCHF/lågkolhydratfilter är angivna apptrösklar; inget filter intygar medicinsk lämplighet för diabetes.

Som standard visas bara recept vars alla inköpsingredienser fortfarande har aktuella, tillgängliga kopplingar. `availableOnly=false` kan användas för att visa även recept med tillfälligt saknade produkter. Offerten förklarar vilka kopplingar eller priser som saknas.

Svaret innehåller `recipes` och `nextCursor`. Skicka samma sökparametrar tillsammans med `cursor=nextCursor` för nästa sida. Ändrade filter eller databasversion kräver ny paginering. `limit` är 1–100. Sammanfattningens `filters` mappar filter-ID till tillstånd; fullständiga etiketter finns i `/meal/filters`.

### Recept och aktuella kopplingar

`GET /meal/recipes/123` returnerar `source` med alla ursprungliga receptfält, `profile` med näringsunderlag, `quality` med listkontrollen, `filters` med tillstånd/bevis och `ingredients` med enheter, mängder och återställningsbevis.

I varje ingrediens används:

```json
{
  "ingredient_original": "eggs",
  "unit": "count",
  "measured_quantity": "3",
  "connection": {
    "status": "matched",
    "willysItemId": "CURRENT_PRODUCT_ID",
    "priceFresh": true,
    "product": {
      "priceOre": 2490,
      "priceUnit": "kr/st",
      "observedAt": "...",
      "expiresAt": "...",
      "pack": {"quantity": 6, "unit": "piece", "approximate": false}
    }
  }
}
```

`matched` har en produktkoppling. `non_purchased` är exempelvis vatten som inte behöver köpas. Om matchning/pris saknas visas en tydlig annan status; den ska inte tolkas som gratis. Föråldrade eller förbjudna produkter används inte som aktuella prisuppgifter.

### Gemensam offert och inköpslista

```json
{
  "recipes": [
    {"recipeId": 123, "servings": 4},
    {"recipeId": 456}
  ]
}
```

Skicka detta till `POST /meal/quote`. Högst 32 receptval, 400 olika ingrediensnamn och 500 ingrediensrader per offert stöds. Samma recept får förekomma flera gånger. Utelämnat `servings` använder hela originalreceptet. Om originalets portionsantal saknas kan appen använda hela receptet, men kan inte skala till ett nytt portionsantal utan ett verifierat ursprungsantal.

Svarsfält:

- `complete`: alla inköpsingredienser har beräkningsbar förbrukningskostnad.
- `consumedCostOre`: total för ingredienserna som förbrukas; `null` om något saknas.
- `knownConsumedCostOre`: endast de delar som kunnat beräknas.
- `purchaseComplete`: dessutom kan alla hela förpackningar och pant prissättas.
- `purchaseCostOre`: summa hela förpackningar/viktvaror plus pant; annars `null`.
- `shoppingList`: produkt-ID, mängd, antal förpackningar, förbrukningskostnad, inköpskostnad och pant. Samma produkt summeras mellan recepten innan antal förpackningar avrundas uppåt.
- `unresolved`: recept/ingrediens och konkret orsak, exempelvis okänd mängd, saknad densitet eller styckvikt.
- `catalogueSnapshotId`, `connectionRunId`, `datasetId`, `pricedAt`, `earliestPriceExpiry`: versions- och aktualitetsuppgifter.

Alla priser uttrycks i öre: 2490 = 24,90 SEK. Enhetspriset för `kr/kg` behandlas som kilopris, medan `kr/st` behandlas som förpackningspris när förpackningsstorlek finns. Villkorade erbjudanden antas inte automatiskt gälla. Källans volymmått använder amerikanska receptmått.

En korrekt produktkoppling innebär inte att alla mängder går att prissätta automatiskt. Exempelvis kräver en kopp mjöl ett verifierat mått i gram och en paprika såld per kilo kräver styckvikt. Kvalitativa mängder som ”efter smak” bevaras och får ingen påhittad vikt. Okända kostnader blir `null`, aldrig noll. Appen kan ge explicita, verifierade mängder med `amountOverrides`:

```json
{
  "recipes": [{
    "recipeId": 123,
    "servings": 4,
    "amountOverrides": {
      "0": {"unit": "g", "quantity": 150}
    }
  }]
}
```

Nyckeln `0` är ingrediensens position. Override-mängden avser hela ORIGINALRECEPTET och skalas därefter med efterfrågade portioner. Tillåtna enheter är `g`, `ml` och `piece`. En override ändrar ingen lagrad mängd eller produktkoppling. API:t beräknar inte om originalets näringsvärden efter ingrediensbyten eller andra override-antaganden.

### Uppdateringar och fel

Katalogen och ingredienskopplingarna uppdateras dagligen av den befintliga workflowen. Kopplingsjobbet läser **enbart de 881 ingrediensnamnen och deras förekomster från den uppladdade molndatabasen**. Det verifierar innehållshash och policy och faller inte tillbaka till den gamla större listan. Matchningen använder samma tidigare granskningar, jämför kompatibla godkända alternativ och byter produkt-ID när ett alternativ försvinner eller ett annat blir billigare.

Receptens aktuella kopplingar och offerter läser de aktiva katalog-/kopplingsversionerna vid anropet. Om katalogen har uppdaterats men matchningen ännu inte är färdig svarar offert och standardsökning `503 connections_refresh_pending`. Appen kan visa receptets innehåll med status för väntande koppling och försöka igen senare. Saknade/tillfälligt otillgängliga ingredienser utesluter receptet från standardsökningen tills en godkänd koppling åter finns.

Statiska recept/filter ändras inte av prisuppdateringar. En senare ändring av urval eller klassificeringsregler kräver en ny uttrycklig databasrelease. Denna import installerar en låst release och vägrar skriva över en annan installerad version.

`401` betyder fel/saknad token, `400` felaktiga parametrar, `404` saknat recept/produkt, `409` ändrade sidfilter/version, `413` för stor JSON-kropp, `422` okänd portionsgrund och `503` import/uppdatering som pågår eller en otillgänglig databas. Läs alltid fältet `error`. Försök igen med väntetid vid tillfälliga `503`, och kontrollera `/meal/status` vid import.

Cloudflare Free har även läs- och anropsgränser. Detta är ett kostnadsfritt startupplägg inom dessa gränser, inte obegränsad trafik. Referenser: [D1-priser och dagskvoter](https://developers.cloudflare.com/d1/platform/pricing/), [D1-gränser](https://developers.cloudflare.com/d1/platform/limits/), [GitHub stora filer/releases](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github).
