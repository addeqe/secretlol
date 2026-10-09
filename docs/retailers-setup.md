# Coop-drift och lokal ICA-förberedelse

Dokumentet beskriver Coop som den nya anslutna kedjan bredvid Willys. ICA förblir avstängt och uppskjutet eftersom serverns produkt-/prisanrop blockeras. Den 9 oktober slutfördes Coop-startscannen, granskningen, D1-installationen och publiceringen. Coop D1-bindingen och Worker är driftsatta. GitHub Actions-källprovet [37904883640](https://github.com/addeqe/secretlol/actions/runs/37904883640) och det normala dagsjobbet [37908550399](https://github.com/addeqe/secretlol/actions/runs/37908550399) passerade.

## Aktuell status: 9 oktober 2026

Startscannen av Stora Coop Västberga (256600, pickup) omfattar 14 368 unika produkter, 748 lövkategorier och 1 121 sidor. Granskad publicering omfattar 881 ingrediensnamn: 564 matchade, 311 behöver granskning och 6 behöver inte köpas. Det ger 7 230 recept med fullständig Coop-koppling och 82 876 kopplade förekomster av 96 082. Coop spårar 376 godkända produkt-ID:n; olösta ingredienser förblir olösta.

Alla fem receptimportdelar är klara och `/meal/status` visar `ready: true`. Det tillfälliga `meal-upload`-workflowet är avstängt. Daglig Coop-refresh är aktiverad. ICA har ingen godkänd automatisk produkt-/priskälla.

Den nya beräkningsvägen via Durable Objects finns i källkoden, men dess slutliga driftsättning och CPU-prov återstår. API och dagsjobb fortsätter använda samma publika adress och kontrakt.

## Börja offline

CLI:ns standardkommando är en syntetisk demo. Den använder en markerad testfixture, skapar en temporär lokal databas i minnet och visar både ändrad och oförändrad publicering samt en whole-package-korg. Den gör noll retailer- och Cloudflare-anrop.

```sh
npm run retailers -- demo
npm run retailers -- capabilities --retailer coop
npm run retailers -- capabilities --retailer ica
npm run retailers:init
```

Demo kan sparas i en lokal SQLite-fil med `--local data/retailer-demo.sqlite`; det är fortfarande syntetiska data och inte en källa för butikens sortiment eller pris.

## Faktisk CLI-syntax

Skriptet `npm run retailers -- ...` stöder:

```text
demo
capabilities --retailer coop|ica
scan --retailer coop|ica --store-id ID [--channel pickup|delivery] [--slot-id ID] --allow-live [--output FIL]
archive --input SCAN.json [--output FIL.json.gz]
inventory --remote --confirm-cloudflare [--output FIL]
review --retailer coop|ica --input SCAN.json --inventory INVENTORY.json [--output FIL]
publish --retailer coop|ica --input REVIEWED.json --inventory INVENTORY.json [--categories TREE.json] --local FIL.sqlite
publish --retailer coop|ica --input REVIEWED.json --inventory INVENTORY.json [--categories TREE.json] --remote --confirm-cloudflare --write-budget RADER
refresh --retailer coop|ica --store-id ID [--channel pickup|delivery] --allow-live --local FIL.sqlite
refresh --retailer coop|ica --store-id ID [--channel pickup|delivery] --allow-live --remote --confirm-cloudflare --write-budget RADER
```

`scan` använder lokala checkpoints, som kan väljas med `--checkpoint MAPP`. Det kräver `--allow-live` och skriver bara en lokal insamlingsartefakt; den publicerar inte. `review` och `archive` arbetar offline. Coop-publicering validerar granskningen mot hela startkatalogen, kategoriträdet, tidigare granskade förslag och eventuella manuella kandidatnomineringar. Nomineringar är låsta till butik, inventering och katalogens kontrollsumma; varje faktiskt produktval kräver ett separat granskningsbeslut. Om priserna från startscannen hunnit gå ut före publicering kan `publish --allow-live` först kontrollera de godkända ID:na igen. Förändrad produktidentitet kräver ny granskning; verkliga prisdatum skrivs aldrig om för att få gamla data att verka färska. Molnkommandon kräver dessutom `RETAILERS_CLOUD_ENABLED=true` och anslutna Cloudflare-variabler. Kommandot `inventory` läser molnets receptinventering; kör det först när sådan läsning uttryckligen är godkänd.

`npm run retailers:init` (eller `node scripts/init-retailers.ts`) visar lokalt planläge och kontaktar inte Cloudflare. Coop-molninitiering kräver `--retailer coop --remote --confirm-cloudflare`, `RETAILERS_CLOUD_ENABLED=true` och giltig konfiguration. Initieringen kan skapa Coop-databasen, spara ID:t och köra fjärrmigrationen. Kör inte ICA-initiering. Coop hämtning kräver `COOP_PUBLIC_SUBSCRIPTION_KEY`: den är en offentlig klientnyckel som Coop själv använder i webbläsaranrop, inte en Cloudflare-credential. Lägg den som GitHub Actions-secret för dagsjobbet så att den maskeras i loggar. Behandla den som konfiguration och begränsa användningen till Coops tillåtna API.

Viktigt: `--write-budget` är en explicit, konservativ övre gräns för den skrivande D1-klientens räknade rader och kontrolleras även mot en uppskattning innan publicering. Det är inte en Cloudflare-kontokvot eller reserverad andel. D1-budgeten delas med Willys och receptimporterna. Kontrollera kontots faktiska återstående kvot innan skrivning; flaggan säkerställer inte att kontot har tillräckligt utrymme.

CLI:n laddar inte `.env` automatiskt. Anslutningsvärden kan laddas med Nodes `--env-file=.env`. Coop-installation efter kvotkontroll: `RETAILERS_CLOUD_ENABLED=true node --env-file=.env scripts/init-retailers.ts --retailer coop --remote --confirm-cloudflare`. Installera bara Coop-databasen. Det här kommandot driftsätter inte Worker eller aktiverar dagsjobbet.

## Daglig Coop-uppdatering

`.github/workflows/retailers.yml` är aktiverat för enbart Coop, dagligen 04:50 UTC och vid manuell start; ICA ingår inte. Körningen den 9 oktober verifierade alla 376 godkända huvud- och reserv-ID:n med noll produktändringar, 4 D1-skrivningar och 4 034 läsningar. Databasen var 1 679 360 byte. Workflowet använder `npm ci` för låsta beroenden.

Före varje uppdatering frågar `scripts/check-retailer-quota.ts` Cloudflares D1-analys efter dagens UTC-skrivningar i hela kontot. Körningen går vidare endast när uppmätt användning + `COOP_WRITE_ALLOWANCE` + `COOP_SHARED_WRITE_RESERVE` högst är `COOP_ACCOUNT_WRITE_LIMIT`. Nuvarande värden är 7 000 för Coop, 10 000 reserverade skrivningar och 90 000 som kontogräns. Coop-budgeten täcker den konservativa uppskattningen 6 413 även om alla 376 produkter, priser och 881 kopplingsstatusar ändras. Saknad/ogiltig kvotdata stoppar körningen; otillräckligt utrymme skjuter upp den. Samma allowance begränsar publiceringen. Willys och receptimport delar fortfarande kvoten; kvotkontrollen reserverar inget åt andra jobb utöver det uttryckliga reservvärdet.

Actions-inställningar för Coop-jobbet:

| Typ | Namn | Användning |
|---|---|---|
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Kontot för kvotkontroll och D1 |
| Secret | `CLOUDFLARE_API_TOKEN` | Cloudflare GraphQL-kvot och D1-access |
| Variable | `COOP_DATABASE_ID` | Installerad Coop D1-databas |
| Secret | `COOP_PUBLIC_SUBSCRIPTION_KEY` | Coops klientnyckel för källhämtning; maskeras i Actions-loggar |
| Variable | `COOP_REFERENCE_STORE_ID` | Verifierad referensbutik |
| Variable | `COOP_REFERENCE_CHANNEL` | Ska vara `pickup` |
| Variable | `COOP_WRITE_ALLOWANCE` | Max antal skrivningar avsatta för refreshen, 1–50 000 |
| Variable | `COOP_DAILY_ENABLED` | Sätt till `true` först när driften är redo |
| Optional variable | `COOP_SHARED_WRITE_RESERVE` | Gemensam kvotreserv; standard 10 000 |
| Optional variable | `COOP_ACCOUNT_WRITE_LIMIT` | Gräns för dagens D1-skrivningar; standard 90 000 |

Det behövs ingen betald AI-runtime eller AI-API för workflowet eller kundens vanliga API. Den publika Coop-nyckeln är upstream-konfiguration; Cloudflare-kontot och API-token är hemligheter och får aldrig skrivas ut.

## Källornas status

| Kedja | Verifierat | Inte verifierat och därför avstängt |
|---|---|---|
| Coop | Pickup-butiksförslag via postnummer, kategoriträd, kategoribrowse utan sökord, produkt-/batchuppslag och onlinepriser med uttryckligt butiks-ID. Full startscan, GitHub Actions-källprov (37904883640), D1/Worker-driftsättning, molnpublicering och daglig refresh (37908550399) har verifierats. | Leverans-/slot-scope och generell ID-portabilitet är inte verifierade. Generiskt EAN-pris används aldrig som lokalt butikspris. |
| ICA | Butiksförslag via postnummer och automatiskt butiksspecifikt kategoriträd. En anonym webbläsarsession visar lokal kategori, produkt och priser. | Produkt-/prisanrop från backend eller Actions: serveranrop får CloudFront 403, medan den vanliga webbappen använder `AwsWafIntegration.fetch`. Full pagination och ID-portabilitet återstår också. |

Kapabilitetskommandot visar adapterkonfiguration, inte bevis för att alla upstream-kontroller lyckas just nu. ICA:s fungerande anonyma webbläsarsida är inte bevis för automatisk källa. Aktuell checklistestatus finns i [Coop/ICA-arbetslistan](coop-ica-todo.md), och det godkända arbetssättet i [planen](coop-ica-plan.md).

## API i drift

API:t ligger på samma auktoriserade Worker som matplaneraren. De nya anropen är:

- `GET /retailers` visar anslutning, konfiguration, referensscope, senaste uppdatering och adapterkapabiliteter. Standardkedja för gamla klienter är fortfarande Willys.
- `GET /stores?retailer=ica&postalCode=11455` föreslår butiker per postnummer. Byt `ica` till `coop` vid behov. Det kräver att retailer-liveuppslag har aktiverats och att adapterfunktionen stöds. Coop visar just nu pickup-förslag från första resultatsidan; leverans är inte verifierad.
- `GET /retailers/coop/products?ids=ID,ID` ger upp till 100 spårade produkters namn, EAN, förpackning, pris, butik och aktualitet. Svaret markerar gamla eller oanvändbara priser med `publicPriceUsable: false`; det gör inget nytt Coop-anrop.
- `GET /retailers/openapi.json` beskriver tillägget.
- `POST /meal/quote` kan ta `retailer: "coop"` eller `"ica"`, upp till tre menyfinalister, och `priceMode: "reference"` eller `"local"`.

API-exempel: rangordna två menyfinalister efter referensdata. Coop-katalogen är ansluten och offertflödet har verifierats; recept-ID:n och budgeten nedan är exempel. ICA är inte anslutet.

```http
POST /meal/quote
Authorization: Bearer <token>
Content-Type: application/json

{
  "retailer": "coop",
  "priceMode": "reference",
  "budgetOre": 90000,
  "finalists": [
    { "id": "menu-a", "recipes": [{ "recipeId": 123, "servings": 4 }] },
    { "id": "menu-b", "recipes": [{ "recipeId": 234, "servings": 4 }, { "recipeId": 345, "servings": 2 }] }
  ]
}
```

För en lokal ICA-offert skickas bland annat butik och handelsform. Det svaret får endast bli tillgängligt när automatisk prishämtning och eventuella lokala produktmappningar har verifierats. Dagens ICA-adapter klarar inte detta; förfrågan ska för närvarande misslyckas stängt med 503.

```json
{
  "retailer": "ica",
  "priceMode": "local",
  "storeId": "account-store-id",
  "channel": "pickup",
  "finalists": [
    { "id": "menu-a", "recipes": [{ "recipeId": 123, "servings": 4 }] },
    { "id": "menu-b", "recipes": [{ "recipeId": 234, "servings": 4 }] }
  ]
}
```

Svar kan innehålla `priceMode`, `priceSource` (`reference-webshop` eller `local-webshop`), `datasetId`, `inventoryHash`, `policyVersion`, `pricedAt`, `earliestPriceExpiry`, `finalists`, `selectedMenuId`, `referenceCostIsEstimate` och `cheapestVerified`. Lokalofferten använder en snabb, märkt referensuppskattning och gör den riktiga korgoptimeringen med kundens lokala priser. Varje meny beräknas en gång; totalt högst 20 000 arbetssteg delas mellan finalisterna. Varje finalist redovisar korgens `complete`, `optimizationComplete`, `purchaseCostOre`, `consumedCostOre`, rader med antal hela paket/pant/restmängd samt olösta ingredienser. `complete` beskriver om alla kostnader kunde lösas; `optimizationComplete` anger om sökningen kunde bevisa bästa korgen inom beräkningsgränsen. Delad lokal priscache lagrar grupper av produktuppslag under en kort hashnyckel. Det undviker ett cacheanrop per produkt; varm minnescache återanvänds även mellan olika menyförslag. Inga kundofferter skrivs i D1. Lokalt webbshoppris är inte ett löfte om fysisk hyllkostnad eller leveransavgifter.

## Beräkningslager och CPU-gränser

Den publika Worker fungerar som en liten gateway: den hanterar `/health`, tillämpar samma bearer-tokenregler som tidigare (inklusive separat token för granskning) och skickar sedan den oförändrade begäran till `MealCompute`. Svaret, API-vägarna och behörighetsreglerna ändras inte. Beräkningen körs i en SQLite-baserad Durable Object-pool med 32 fasta shards. En hash av metod, URL och högst de första 4 096 råa body-byten väljer shard. Identiska anrop hamnar därför tillsammans även när request-ID:t ändras. Shard-affinitet behövs inte för korrekthet.

Durable Object-klassen använder inte sin egen SQLite-lagring, sparar inga offerter permanent och startar inga larm, timers eller bakgrundsjobb. Den använder befintliga D1-bindningar; D1:s separata läs-/skrivkvoter gäller fortfarande. Den begränsade offertcachen delas i minne av objekten i samma isolate; Cache API används dessutom när det är tillgängligt. Minnescachen har högst 64 poster och 4 MiB nominellt sammanlagt, med högst 256 KiB per svar och 64 KiB per nyckel. Nycklarna omfattar begäran och aktuella data-/policy-/kopplingsversioner, aktiv körning och lokala mappningsidentiteter. Cacheträffar kontrollerar att körningen fortfarande är aktuell; utgångstiden begränsas av pris-, observation- och körningsfärskhet. Gränsen räknar UTF-8-innehåll och nycklar; JavaScripts faktiska heap innehåller även sträng- och objektoverhead. Samma cache delas så att 32 objekt inte kan multiplicera minnesbudgeten. Minnescachens innehåll försvinner när isolaten stängs.

På Free har den vanliga Worker-begäran 10 ms CPU-tak. Durable Object-begäran har 30 sekunders standardtak. Durable Objects på Free har dessutom högst 100 000 anrop per dag och 13 000 GB-sekunder per dag; aktiv tid omfattar även väntan på I/O medan objektet är aktivt. SQLite-baserade Durable Objects är tillgängliga på Free. Ingen betald plan eller AI-runtime används. Se Cloudflares aktuella [DO-gränser](https://developers.cloudflare.com/durable-objects/platform/limits/), [DO-prissättning och Free-kvoter](https://developers.cloudflare.com/durable-objects/platform/pricing/) och [Worker-gränser](https://developers.cloudflare.com/workers/platform/limits/).

CPU-proven använder Cloudflare Analytics efter en kort probeperiod och är adaptivt samplade; de visar inte exakt vilken URL eller Worker-version som använde varje sample. Kör dem efter driftsättning och probe:

```sh
npm run worker:cpu -- --input data/worker-api-probe.json --output data/worker-cpu-report.json
npm run compute:cpu -- --input data/worker-api-probe.json --output data/compute-cpu-report.json
```

`worker:cpu` har 8 ms som standardgräns och `compute:cpu` 200 ms. Båda avslutar med fel om nödvändiga Analytics-data saknas eller färre begäranden syns än provet förväntar; Durable Object-provet kräver både invocations- och periodiska mätvärden. Mätvärdena är regressionsbevis för probeperioden, inte en garanti för alla framtida trafikmönster.

Efter ändringar i kostpolicy eller identitetsregler kan den offline-genererade policycachen byggas om från den granskade artefakten. Kommandot gör inga nätverksanrop:

```sh
npm run policy:seed -- --input data/coop-reviewed-dataset-20261009.json --output src/dietary-policy-seed.ts
```

`npm run meal:quotes` är ett valfritt D1-underhållskommando som bygger kompakta receptprojektioner i `MEAL_DB`; det använder inte Durable Object-lagringen och skriver inte kundofferter. Det kontrollerar kontots dagskvot och reserverad delad marginal före skrivning. Kör det bara när en kvotkontroll har godkänt underhållet. Standardtilldelningen är högst 1 000 skrivningar, med 10 000 reserverade och 90 000 som gräns; `MEAL_QUOTE_WRITE_ALLOWANCE` och `MEAL_QUOTE_ACCOUNT_WRITES_FLOOR` kan styra dessa försiktigare.

Förbrukningskostnaden summeras utan avrundning över alla produkter och avrundas sedan till hela ören. Enskilda raders visningsbelopp avrundas separat, så deras summa kan skilja något från totalsumman. Inköpskostnaden summerar produktens faktiska paket-/viktkostnad inklusive pant. Mängder under `1e-9` gram, milliliter eller styck, eller mängder som inte kan summeras med bibehållen numerisk precision, markeras som olösta i stället för att få nollkostnad.

## Driftkontroller

1. **Klart:** verifiera Coop pickup-källa från GitHub Actions i körning [37904883640](https://github.com/addeqe/secretlol/actions/runs/37904883640).
2. Före framtida molnskrivning ska den aktuella delade Cloudflare-kvoten fortfarande kontrolleras. Workflowets preflight gör samma kontroll inför refresh.
3. **Klart:** installera Coop D1, driftsätt Worker-bindingen och publicera de granskade kopplingarna och spårade produkterna.
4. **Klart:** normal uppdatering från GitHub Actions använder bara 376 granskade ID:n och har verifierad deltaförbrukning. Durable Object-arkitekturen är driftsatt och har verifierats med 18 lyckade API-anrop, inklusive tre finalister med 32 recept vardera. Gateway-CPU och begränsningen i DO-telemetrin redovisas i [verifieringen](retailer-verification.md).
5. ICA:s produkt-/priskälla återstår separat; detta Coop-jobb aktiverar aldrig ICA.

Det vanliga kund-API:t och dagsjobbet behöver ingen betald AI-runtime. Fulla scans är en engångs-/återhämtningsåtgärd, inte en rutin. Upstream-begränsningar kan göra att bara en del av planen kan genomföras nästa arbetsdag.
