# Lokal receptimport: Kaggle → parser → allergener/halal → USDA → Willys

Infrastrukturen bearbetar recept lokalt utan LLM-anrop, betalda tjänster eller
nätverksanrop per recept. Den skriver till en separat SQLite-databas för staging
och JSONL. Den ändrar inte den aktiva receptdatabasen eller Cloudflare.

**Massimporten ska inte återupptas ännu.** Kvalitetsgranskningen 2026-10-12
visade både alltför låg andel kompletta recept och felaktiga äldre godkännanden.
En körning utan krasch är inte ett kvalitetstest. Aktuella ändringar och
separata testresultat dokumenteras i [den senaste täckningsgranskningen](recipe-ingestion-coverage.md).
Tidigare rapporter nedan är historik och godkänner inte en ny masskörning.

Den genomförda provkörningen omfattar **50 slumpmässiga recept**, dragna utan
innehållsfilter ur **2 231 142 rader**. Hela CSV-filen lästes för att dra ett
likformigt stickprov och beräkna dess checksumma. Bara de 50 recepten parsades.
Resultat och begränsningar finns i [provrapporten](offline-recipe-sample-50.md).

En separat [portions- och utbytesparser](recipe-yield-parser.md) har därefter
lagts till och provats på samma 50 plus fem nya omgångar om 50. Den skiljer
personportioner från exempelvis 30 kakor och sparar textbelägg, osäkerhet och
näring per styck separat. Den äldre provrapporten är den bevarade baslinjen.

## Komponenter och datakällor

| Steg | Lokal komponent | Beteende |
| --- | --- | --- |
| Ursprung | [Kaggle RecipeNLG](https://www.kaggle.com/datasets/wilmerarltstrmberg/recipe-dataset-over-2m/data) | Ursprunglig titel, ingrediensrader, instruktioner, länk och radnummer bevaras. |
| Parser | [ingredient-parser](https://github.com/strangetom/ingredient-parser), `ingredient-parser-nlp==2.8.0` | Förtränad modell som körs lokalt. Namn, mängd, enhet, storlek, beredning och konfidens sparas. Ingen generativ AI. |
| Allergener | [Open Food Facts taxonomi](https://github.com/openfoodfacts/openfoodfacts-server/blob/b90bcf61bf0e86b5f7925b2c53f569eb1ae5b598/taxonomies/allergens.txt) | Lokal kopia, SHA-256-kontrollerad. Engelska alias och föräldrakategorier kopplas till appens 14 allergenaxlar. Befintliga konservativa ingrediensregler återanvänds. |
| Halal | `src/dietary-policy.ts` | Samma regler och märkeskrav som befintliga Willys-kopplingar. Kontrollerar ursprungsrad, parsade namn, titel, instruktioner och vald produkt. |
| Näring | [USDA FoodData Central SR Legacy, april 2018](https://fdc.nal.usda.gov/download-datasets/) | Lokal SQLite: 7 793 livsmedel, 66 963 näringsposter, 14 431 portionsvikter. Ingen närings-API används. |
| Willys | Befintlig matchare, granskade identiteter och lokal katalog | Produktpooler byggs en gång. Samma regler för livsmedelsform, attribut, märken, pris och veckobaserad färskhet. |

OFF-källans version och checksumma ligger i `offline/assets/allergens-source.json`.
Respektera [OFF:s käll- och licensvillkor](https://github.com/openfoodfacts/openfoodfacts-server/blob/main/COPYRIGHT)
vid vidare distribution. USDA-källans hash och sammanställning sparas i SQLite.
Kopian av projektets befintliga allergen-/kostregler har ursprungsmanifestet
`offline/assets/ingredient-rules-source.json`; halalreglerna importeras direkt
från den befintliga TypeScript-koden.

## Beslutsregler

- Kända vikt- och volymenheter normaliseras till gram och milliliter; räknade
  ingredienser behåller antal. Amerikanska receptmått används uttryckligen.
- `2 (400 g) cans ...` kan bli 800 g. `1 can ...` utan storlek får ingen gissad vikt.
  Ett fullständigt, uttryckligt första alternativ kan väljas med bevarat belägg;
  hela originalraden halalgranskas fortfarande. Ett uttryckligt mängdintervall
  använder sin övre gräns med sparat originalintervall och valbelägg. Uttryckligt
  ungefärliga tal märks som sådana. Saknade tal, olösta alternativ och låg
  parserkonfidens spärras.
- Kopp → gram använder en verifierad, livsmedelsspecifik portionsvikt. En kopp
  mjöl behandlas aldrig som en kopp vatten. Standardstorlek och vissa saknade
  detaljer om hackning/packning kan uppskattas med ett dokumenterat hushållsmått;
  antagandet sparas. Namngiven storlek och rå/tillagad form bevaras. Ett fåtal
  kompletterande publicerade vikter finns i `offline/assets/household-measures.json`,
  med källa och exakt livsmedelsform. Ingen regel fyller i en saknad mängd.
- USDA-identitet kräver ett uttryckligt alias, en unik bokstavlig referens eller
  exakt beskrivning. Oklara kandidater får ingen automatisk toppträff. Alias kan
  utökas i `offline/assets/usda-food-aliases.json` med verifierat USDA-ID.
- Näring beräknas som `summa(gram × näringsvärde per 100 g / 100)` för nio
  näringsämnen. Saknade bidrag blir `null`, aldrig noll. Per portion beräknas
  bara när portionsantal uttryckligen finns i källan/instruktionerna.
  Exakt styckutbyte kan ge `perYieldUnit`; det fyller inte `perServing`.
- Näringen är en uppskattning från generiska livsmedel. Tillagningsförluster,
  avrunnen vikt, svinn och oljeupptag beräknas inte genom gissningar.
  Frityrolja, salt i kokvatten för ägg i skal och mjölk som separeras i ostmassa
  och bortkastad vassle har därför okänd näringsretention och blir inte kompletta.
  Detta gäller även olja efter avrinning på papper och en marinad som maten tas
  ur utan att hela resterande marinaden används.
- Gamla mått som `c.`, `Tbsp.`, explicit förpackningsvikt, amerikanska smörstavar
  och `dozen` normaliseras med källbelägg. `34 cup` korrigeras inte till `3/4`;
  en möjlig borttappad bråkseparator kräver granskning. Rågade/knappa mått får
  ingen påhittad vikt.
- Med `--measured-reference` kan en skadad mängd återställas från den lokala,
  granskade Food.com-källan. Recept-ID, titel, fullständiga instruktioner,
  ingrediensordning, identiteter och läsbara mängder måste stämma. Konfliktfyllda
  versioner avvisas. Ursprungliga rader och den exakta referensen bevaras.
  `to taste` och andra kvalitativa mängder fylls inte i från ett annat recept.
- I degrecept kan ett enda uttryckligt vattenmått i instruktionerna läggas till
  ingredienslistan med ordagrant textbelägg och textposition. Tvättvatten,
  ångbad, flera olika mängder och en redan befintlig vattenrad avvisas av regeln.
- Saknade näringsvärden blir fortfarande okända. Det enda kompletterande
  näringsundantaget är granskade Granny Smith-värden från USDA:s generiska råa
  äpple med skal; varje lånat värde har ett eget USDA-ID och uppskattningsbelägg.
- Namngivna ingredienser i titel/instruktioner måste stämma med ingredienslistan.
  En tydligt avgränsad, titelbekräftad ingredienssektion i instruktionerna kan
  återställas ordagrant. Ugnsuppvärmning ensam räknas inte som färdig tillagning;
  hänvisningar till saknad sås, glasyr, botten eller återstående dessertlager
  stoppas när de känns igen. Detta är en heuristisk kontroll, inte ett bevis på
  att alla källfel i arkivet har upptäckts.
  Icke-mat exkluderas. Deg och andra igenkända komponenter märks separat och
  räknas inte som kompletta måltider i förkontrollen.
- Allergen-/koststatus har tre värden: `yes`, `no`, `unknown`. Okända sammansatta
  produkter blir inte automatiskt allergenfria. Produktetiketters fulla innehåll,
  spårmärkning och korskontamination är inte verifierade av namnklassificeringen.
- Kyckling tillåter Eldorado samt Affco, Qibbla Halal, Agadeer, Aladin och Jack
  Links. Annat kött tillåter samma lista utan Eldorado. Pork, alkohol, osäkra
  animaliska källor och extrakt hanteras av befintlig strikt policy. Detta är
  projektets ingrediens-/märkespolicy, ingen ny halalcertifiering.

`ready` kräver godkänd halalpolicy, mängd och godkänd inköpskoppling för varje
ingrediens och komplett näringsberäkning för hela receptet. Portionsantal är
frivilligt: olöst antal sparas som varningen `servings_unresolved`, inte som ett
importhinder. `RecipeServings` och näring per portion förblir då `null`; hela
receptets näring finns i `nutrition.recipeTotal` och
`profile.nutrition_metrics.nutrients_recipe_total`. Appen kan inkludera receptet
och behöver en angiven fördelning innan den visar näring per person.
Rapporten skiljer på `readyWithPersonServings` och `readyWithoutPersonServings`.
Vatten kan vara
`non_purchased`. Andra recept får `excluded_halal`, `excluded_nonfood`, `unresolved`, `duplicate`
eller `invalid_source`. Tekniska fel i ett enskilt recept ger `processing_error`
och en post i granskningskön. Kvalitativa originalmängder bevaras i ursprungsraden men
ger ingen påhittad inköps- eller näringsmängd.

Ett känt produkt-ID och en kostnadsberäkningsbar mängd är separata saker.
`amount_unresolved` kan därför behålla ett produkt-ID. Det räknas inte som en
färdig koppling för en plan. Produkter med osäker förpacknings-/avrunnen vikt
spärras även om deras livsmedelsidentitet är känd. Angiven ungefärlig produktvikt
får användas som tydligt märkt prisuppskattning, men en örtkrukas vikt används
inte som ätbar bladvikt. Granskade hela frukter med känd förpackningsstorlek
prissätts per styck, med kontroll av produkt-ID, namn och volymetikett.

## Installation och resurser

Kör från katalogen `willys-catalog`, med Python 3.12 och Node 24 eller senare.
Denna installation och alla resurser finns redan på arbetsdatorn. På en ny dator
görs följande engångsförberedelser med nätverk innan importen körs:

```bash
python3 -m venv data/recipe-ingestion-venv
data/recipe-ingestion-venv/bin/pip install -r offline/requirements.lock
data/recipe-ingestion-venv/bin/python -m nltk.downloader -d data/recipe-ingestion-resources/nltk averaged_perceptron_tagger_eng
npm ci
```

Hämta datasetet från källan och placera dess `recipes_data.csv` i
`data/recipe-ingestion-source/`. Den verifierade lokala filen har SHA-256
`fc9828f72b869668dd33189ed3afcac16be167fb030b748c15ea5ea48c1ac2c5`.
CSV-versionen har inga färdiga näringsvärden eller separat portionskolumn.

Bygg USDA-databasen från den redan hämtade officiella SR Legacy-zipfilen:

```bash
data/recipe-ingestion-venv/bin/python offline/recipes.py prepare-usda \
  --archive /home/adde/Music/food_unit_reconstruction/data/reference/fdc_sr_legacy_2018-04.zip
```

På annan dator anger du arkivets lokala sökväg. Förväntad arkivhash är
`b80817294b8850530aaedf2e515c02593b1824f763a0ff356e5c2081643e6fd0`.
Portionsreferenser och alias måste använda samma USDA-utgåva; blandade versioner
avvisas. Den lokala databasen öppnas endast för läsning under importen.

Willys-filen finns redan i `data/recipe-ingestion-resources/willys-catalogue.json`.
Om den behöver uppdateras finns ett **uttryckligt separat molnläsningssteg**:

```bash
node scripts/prepare-recipe-catalogue.ts --fetch
```

Det steget kräver befintlig backendkonfiguration, gör D1-läsningar och exporterar
en komplett katalog samt granskade kopplingar atomiskt. Det skriver inte till D1.
Själva receptkörningen använder bara den resulterande lokala filen. Om NLTK-filer
saknas avbryts körningen före parserimporten, utan automatisk nedladdning.

## Reproducera de 50 recepten

```bash
data/recipe-ingestion-venv/bin/python offline/recipes.py sample \
  --input data/recipe-ingestion-source/recipes_data.csv \
  --output data/recipe-ingestion-resources/random-50-seed20261011.json \
  --count 50 --seed 20261011

data/recipe-ingestion-venv/bin/python offline/recipes.py run-sample \
  --input data/recipe-ingestion-resources/random-50-seed20261011.json \
  --state data/recipe-ingestion-sample/v1/staging.sqlite \
  --output data/recipe-ingestion-sample/v1/run-a

data/recipe-ingestion-venv/bin/python -m unittest discover -s offline -p 'test_*.py' -v
node --test tests/recipe-ingredient-engine.test.ts
npm run check
```

Slumpfröet låser urvalet; inga svåra recept väljs bort. Oförändrat dataset
återanvänder stickprovsfilen. En ändrad fil eller ett nytt frö kräver ett nytt
utdatafilnamn. Provkörningen uppdaterar aldrig checkpoint för en full import.

## Lagring, återstart och en framtida större körning

SQLite innehåller `runs`, `parsed_lines`, `recipes`, `exact_recipes`,
`checkpoints`, `import_issues`, `issue_backfills` och `cache_context_aliases`.
Kod, modell, NLTK-resurs, referensfiler, policy, granskningar,
katalog och utvärderingstid binds till versionshashar. Parser/näring/allergener
har en separat cache, så att en ny katalog inte ensam kräver omparsning.
Semantiska ändringar i parser, referenser eller kvalitetsregler skapar en ny
version. `--resume` vägrar då att presentera den äldre checkpointens resultat
som nyverifierade. De äldre resultaten bevaras; gamla återställningsverktyg för
enbart kraschfixar får inte användas för att kringgå denna kontroll.
Node-bryggan lever under hela körningen och har en begränsad kopplingscache;
parsercachen är också begränsad. Alla källrader behöver inte ligga i minnet.

Kommandot `stream` stöder samma CSV och behandlar **högst 50 rader som standard**.
`--limit N` höjer batchstorleken. `--resume` fortsätter efter senaste checkpoint;
SQLite-transaktion och checkpoint sparas tillsammans var 100:e recept och vid
batchens slut. Färdiga recept sparas även vid Ctrl+C. En avbruten batch kan
återspelas utan dubbla receptposter. En full körning kräver uttryckligen `--all`;
den påbörjade importen är ännu inte färdig. `--all` kör först ett ofiltrerat,
likformigt stickprov om 1 000 recept i separat tillstånd. Huvudimporten startar
bara om godkända recept klarar oberoende data-/räkningskontroll och minst
`--min-ready-percent` procent är kompletta maträtter (standard 5). Det är en
konfigurerbar driftspärr för användbart utbyte, ingen statistisk korrekthetsgaranti.
`--preflight-only` tillsammans med `--all` utför enbart kontrollen, även om den
godkänns. `--preflight-seed` möjliggör ett nytt reproducerbart urval. Ändrat frö
kräver ny utdatakatalog. **Den stora importen är pausad medan täckningen utreds.**

### Se progress medan importen kör

Importterminalen visar sparat radnummer, bearbetade, kompletta, olösta,
halal-exkluderade, icke-mat, överhoppade och hastighet var 100:e recept.
Varje nytt fel meddelas direkt med
radnummer och feltyp. En sammanställning skrivs när batchen är färdig. Du kan
också följa en pågående sekventiell `stream`-import i ett andra terminalfönster:

```bash
cd /home/adde/Music/willys-catalog
python3 offline/watch_recipe_import.py --output data/recipe-import/resultat
```

Ange samma utdatakatalog som importens `--output`. Visningen uppdateras var
femte sekund: antal bearbetade källrader inklusive tidigare återupptagna
batcher, uppmätt hastighet under bevakningen, bevakningstid och tid sedan
senaste skrivning. Den läser bara slutet av utdatafilen och ändrar inga recept,
checkpointar eller importerens kodversion. En pågående import behöver alltså
inte startas om. Under förberedelserna visas att receptutdata inväntas.

Ctrl+C i **progressfönstret** avslutar bara visningen. Oförändrade utdata kan
inte i sig avgöra om importen arbetar med ett långsamt recept eller har stannat;
kontrollera då importterminalen. En färdig rapport märks som senast avslutade
körning. `--once` visar en enda avläsning. Visningen är avsedd för `stream`,
inte slumpurval där källradnumren hoppar mellan recepten.

### Återhämtning efter parserfel i ett felaktigt bråktal

Källrad 66 957 (nollbaserat) innehåller `3 1\\2 tsp. Baking Powder`.
Ingredient-parsers enhetstolkning gav här `tokenize.TokenError`, vilket tidigare
avbröt importen. Den lokala adaptern fångar nu även `TokenError` och `SyntaxError`.
Originalraden bevaras med `parse_error`, okänt namn och okänd mängd; ett korrekt
bråktal eller en produkt gissas inte. Resursfel som `MemoryError` döljs inte.

Eftersom ändrad kod normalt skapar en ny importversion finns en separat,
begränsad återställning i `offline/repair_parser_checkpoint.py`. Den godtar
enbart den här granskade ändringen av felhanteringen, med exakta före/efter-
kodhashar och identiska modeller, referenser, policy, katalog och övrig kod.
Den tar en SQLite-säkerhetskopia inklusive WAL innan något ändras. Därefter
återanvänds de tidigare cacheposterna och recepten utan omparsning. Ursprungliga
receptdokument och deras versionsbelägg behålls; återanvändningen loggas i
`cache_compatibility_migrations`, och båda versionernas metadata behålls i `runs`.

Den utförda återställningens underlag ligger i
`data/recipe-import/parser-recovery-report.json` och säkerhetskopian i
`data/recipe-import/staging-before-token-error-fix.sqlite`. Checkpointen flyttas
bara över en verifierat sammanhängande följd av redan sparade recept. Det vanliga
importkommandot med `--resume` används efter återställningen. Verktyget är en
engångsreparation, inte en generell genväg för att återanvända resultat efter
andra kod- eller policyändringar.

### Hoppa över tekniska receptfel och granska senare

Importen fångar nu även Pint-fel, exempelvis `UndefinedUnitError` från
`2 cans (1 lb. 4 oz. per can) tomatoes` på källrad 336 359 (nollbaserat).
Adaptern bevarar originalraden och feltypen utan att gissa en mängd. Recept
med parserfel eller andra datarelaterade bearbetningsfel sparas som
`processing_error` och importen fortsätter med nästa recept. Ett savepoint
per recept rullar tillbaka halvfärdiga poster och dubblettmarkeringar innan
felposten sparas. Saknade resurser, minnes-/disk-/databasfel eller en trasig
delad Willys-process avbryter fortfarande körningen med ett synligt fel.

Alla tekniska receptfel, inklusive `invalid_source`, sparas beständigt i
SQLite-tabellen `import_issues`. Samma kö exporteras till
**`skipped-recipes.jsonl`** i utdatakatalogen. Varje rad innehåller källans
radnummer, titel, länk, kompletta originaldata, feltyp och bearbetningssteg;
oväntade undantag inkluderar felmeddelande och traceback. Listan uppdateras
vid varje checkpoint, vid batchslut och vid ett hanterat avbrott. Vid återstart
återskapas den från SQLite, så även ett strömavbrott mellan databas- och
filskrivning återhämtas. Samma recept får bara en köpost per importversion.
Normalt olösta mängder, saknade näringsmatchningar och halaluteslutningar
är vanliga kvalitetsresultat, inte tekniska fel, och läggs inte i denna lista.
Parserfel i tidigare sparade recept hämtas också till kön vid första
återstarten; den historiska genomgången görs bara en gång.

För den aktuella stoppade importen bevarar
`offline/repair_import_checkpoint.py` alla tidigare recept och parsercacher
genom en exakt versionsbunden lagringsalias. Granskade kodhashar finns i
`offline/assets/import-recovery-20261011.json`. Övrig kod, modell, katalog,
näringsreferenser och policy måste vara identiska. Originaldokumentens
versionsbelägg behålls. Bara små kontrolltabeller ändras, och deras tidigare
värden sparas i `data/recipe-import/import-recovery-before-controls.json`.
Recept- och cacheinnehåll flyttas eller skrivs inte om. `contextHash` anger
aktuell körversion och `storageContextHash` anger den återanvända
lagringspartitionen. Verktyget är en engångsreparation för denna felhantering.

### Unicode-tecken och återstart av Willys-hjälpprocessen

Receptet `Farro And Sausage Parmigiano` på källrad 1 048 308 (nollbaserat)
har ett osynligt U+2029 i titeln. Node 24:s `readline` delar också på U+2028
och U+2029, vilket tidigare kapade ett giltigt JSON-meddelande och avslutade
hjälpprocessen. Överföringen kodar nu båda tecknen som JSON-escapes; efter
avkodning är originaltexten identisk. Lagrade dokument och parsercachens
innehåll ändras inte. Detta gäller både ingrediens- och policyanrop.

Om hjälpprocessen ändå oväntat avslutas eller tappar protokollet startas den
om och samma anrop provas **en gång**. Omstarten måste ge exakt samma
katalog-/regelmetadata. Inga externa skrivningar görs av dessa anrop.
Upprepade fel avbryter fortfarande med synlig felorsak; städningen ersätter
inte längre originalfelet med ett sekundärt avslutningsfel.

Den granskade kompatibiliteten för denna ändring finns i
`offline/assets/bridge-unicode-recovery-20261011.json`. Återställningsverktyget
kan läsa denna specifika manifestfil med `--manifest` och behåller redan
befintliga lagringsalias. Kontrolltabellernas kopia och återställningsrapport
ligger i `data/recipe-import/bridge-unicode-recovery-before-controls.json`
och `bridge-unicode-recovery-report.json`. De tidigare granskade
reparationernas underlag och originaldokument behålls. Användaren fortsätter
med samma importkommando och `--resume`.

Varje körning skriver `recipes.jsonl`, `report.json` och `skipped-recipes.jsonl` i vald utdatakatalog.
Använd olika utdatakataloger för batcher: JSONL-filen innehåller just den
körningens poster, medan SQLite behåller tidigare poster. Den fullständiga
JSONL-filen ersätter en temporär `.partial` först efter lyckad körning.
Fellistan innehåller däremot hela den aktuella versionens granskningskö,
även från tidigare batcher. Rapporten visar `skippedRecipes` för batchen
och `reviewQueueRecipes` för den samlade kön.
Dedupliceringen gäller identiska normaliserade källrecept, inte semantisk
unikhet mellan olika versioner av samma maträtt.

Dokumenten innehåller receptets källfält, ingredienser, mängder, produkt-ID,
allergen-/kostklassificeringar, näring, policyorsaker och ursprungsevidens.
De är **stagingdokument**, inte en färdig produktionsrelease. Ett framtida
importsteg måste anpassa fältformat till befintlig relations-/releasestruktur,
kontrollera ID-kollisioner och godkännandekrav samt omvalidera katalog/priser.
Det steget aktiveras inte av denna infrastruktur.

Utan `--as-of` används katalogens fasta sluttid för reproducerbara historiska
beslut. Det bevisar inte att priserna är aktuella när filen används senare.
Inför produktion krävs en aktuell katalog och ny utvärdering mot den befintliga
veckobaserade färskhetsregeln.
