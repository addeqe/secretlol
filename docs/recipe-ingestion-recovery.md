# Receptimport: historisk verifiering 2026-10-11

**Detta är den bevarade baslinjen.** Fortsatta rättningar, aktuella resultat och
kvarvarande hinder finns i [täckningsgranskningen 2026-10-12](recipe-ingestion-coverage.md).

**Massimporten är fortfarande pausad.** Kända krasch- och kvalitetsfel har
rättats och testats, men den dåvarande versionens slumpurval gav bara **4 kompletta
matrecept av 1 000**. Det räcker inte för att rekommendera en ny stor körning.
Inga saknade mängder, näringsvärden eller produktidentiteter fylls i för att
höja den siffran.

Den gamla importdatabasen och dess checkpoint är bevarade. Alla nedanstående
körningar använder separata testdatabaser. Inga recept har publicerats och
inga Cloudflare-skrivningar har gjorts i denna granskning.

## Felen som hittades och rättades

| Fel | Nytt beteende och belägg |
| --- | --- |
| Unicode U+2028/U+2029 delade JSON-meddelanden till Node-processen mitt i en sträng. Det orsakade felet vid `Farro And Sausage Parmigiano`. | Tecknen escapes endast under överföringen. Ursprungstexten bevaras. Ett riktigt test med samma titel, båda tecknen och efterföljande förfrågningar behåller samma fungerande process. Ett oväntat processavbrott får ett begränsat omförsök med identisk version. |
| Stora batcher kunde överskrida bryggans gräns på 4 MiB eller 4 000 poster. | Förfrågningar delas efter faktiskt kodad storlek och antal; ordningen bevaras. Testat även mot den riktiga processen med över 4 MiB Unicode-text. |
| Äldre mått, uttryckliga burkvikter och styckmultiplar tolkades fel eller avvisades. | `c.`, `Tbsp.`, `2 cans (1 lb. 4 oz. per can)`, explicita amerikanska smörstavar och `2 dozen eggs` normaliseras med ursprungsbelägg. Två burkar i det exemplet blir 1 133,980925 g; två dussin ägg blir 24 stycken. |
| För få verifierade USDA-alias och brister i hushållsmåtten. | En reproducerbar byggare kopplar uttryckliga livsmedelsidentiteter till unika lokala USDA-poster. Hushållsmått hanterar fler dokumenterade stavningar och former. Standardstorlekar och andra referensantaganden redovisas. |
| Ett köttfärslimpsrecept med ingredienslistan `water, water` fick nollkalorinäring och blev godkänt. | Namngivna ingredienser i titel och instruktioner jämförs med listan. Saknat kött, saknad fyllning och andra upptäckta motsägelser stoppar godkännandet. |
| Ingrediensavsnitt kunde ligga inne i instruktionerna, medan ingrediensfältet var skadat. | Endast ett tydligt avgränsat, titelbekräftat avsnitt kan återställas ordagrant. Ursprunglig lista och exakta textpositioner sparas. Fria instruktioner används inte för att hitta på mängder. |
| Slime, modellera, möbelpolish och liknande kunde bli godkända för att råvarorna gick att köpa. | Ändamålet kontrolleras separat. Icke-mat exkluderas; igenkända komponenter som deg, glasyr och kryddblandningar märks separat. |
| Trasig talnotation som `34 cup` blev 34 koppar, trots en möjlig borttappad bråkseparator. | Den tvetydiga notationen stoppas för granskning. Den skrivs inte om till `3/4`. Rågade och knappa mått får inte heller en påhittad nivåstruken vikt. |
| Frityrolja räknades som helt uppäten. Även salt i kokvatten för ägg i skal och mjölk som separerades till ostmassa/vassle gav missvisande totalsummor. | Berörda näringsbidrag blir uttryckligen okända när retentionen saknar belägg. Inköpsmängden bevaras separat. Receptet räknas inte som komplett. |
| Ätbar fruktmassa kunde blandas ihop med kostnaden för hela frukter. | Granskade styckförpackningar prissätts per faktiskt antal. Produkt-ID, namn, volymetikett och livsmedelsidentitet måste fortfarande stämma. Hel frukt får inte automatiskt samma mängd som pressad juice eller skal. |
| Örtkrukans etikettvikt kunde användas som ätbar bladvikt. | Kopplingen kräver belägg för den ätbara mängden; krukvikten godkänns inte som bladutbyte. |
| Progressen visade många sparade poster utan att tydligt visa hur få som blev kompletta. | Progressen redovisar kompletta, olösta, halal-exkluderade, icke-mat och tekniskt överhoppade separat. |

Kvalitativa uttryck som `few dashes`, skivor utan angivet antal och örtkvistar
utan antal bevaras med okänd mängd. Kända felaktiga källrader isoleras i
`skipped-recipes.jsonl` med originalrecept och felorsak. Resurs-, disk- och
databasfel döljs inte som vanliga receptfel.

## Slutliga testomgångar

Samma slutliga beräkningsversion används i de tre redovisade batcherna:
`128ea738bf1d50dfa697fa05a83dddc0d39bc9162efcd085719799c55a1cb2ba`.

### 50 granskade kontrollrecept

Detta är **utvalda positiva och negativa kontrollfall**, inte ett slumpurval
och inte ett mått på täckningen i hela datasetet. Förväntat utfall finns i
`offline/fixtures/recovery-controls-50.json`.

| Utfall | Antal |
| --- | ---: |
| Kompletta matrecept | 29 |
| Korrekt stoppade som olösta | 10 |
| Halal-exkluderade | 1 |
| Icke-mat | 10 |
| Totalt | 50 |

**Alla 50 fick det granskade förväntade utfallet.** De 29 accepterade recepten
omfattar 106 ingrediensrader och klarade den oberoende data- och räkningskontrollen
utan avvikelser. Två tidigare positiva kontroller ändrades uttryckligen till
negativa efter att frityroljans respektive kokvattensaltets okända retention
konstaterats. Ändringen dokumenteras i kontrollfilen.

Maskinellt resultat:
`data/recipe-ingestion-quality/release-controls/verification.json`.

### Nytt ofiltrerat slumpurval ur hela CSV-filen

1 000 recept drogs likformigt utan innehållsfilter ur alla **2 231 142** rader,
med frö `202610122`. Detta urval valdes efter de senaste ändringarna av
godkännandereglerna. Efterföljande rättningar av transport och filintegritetskontroll
ändrade inte vilka recept som antogs; urvalet kördes om med slutversionen.
Tidigare urval som använts för förbättringar redovisas inte som nya kontrollurval.

| Utfall | Antal |
| --- | ---: |
| Kompletta matrecept | 4 |
| Olösta | 617 |
| Halal-exkluderade | 377 |
| Icke-mat | 1 |
| Tekniskt överhoppad och bevarad för granskning | 1 |
| Totalt | 1 000 |

Alla fyra accepterade recept, totalt 23 ingrediensrader, klarade den oberoende
kontrollen utan avvikelser. De granskades dessutom mot originalets ingredienser
och instruktioner: jordnötssmörskakor, bakad sötpotatisgnocchi, sparris med
vitlök och chapati. Okända personportioner har inte fyllts i.

Den tekniskt överhoppade källraden innehåller `l lb baby romaine lettuce`:
bokstaven `l` görs inte om till siffran `1`. Körningen fortsatte och originalet
finns kvar i granskningslistan.

**Förkontrollen underkändes: 0,40 % kompletta matrecept mot driftspärrens
standardgräns 5 %.** Huvudimportens databas skapades aldrig.

Resultat och kvarvarande vanligaste hinder:

- `data/recipe-ingestion-quality/validated-holdout/_preflight/quality-gate.json`
- `data/recipe-ingestion-quality/validated-holdout/_preflight/verification.json`
- `data/recipe-ingestion-quality/validated-holdout/_preflight/skipped-recipes.jsonl`

### Omprövning av samtliga 230 äldre godkännanden

Alla 230 gamla `ready`-poster hämtades läsande med databasens statusindex och
omprövades i en separat databas. Originaldatabasens statusar ändrades inte.

| Ny bedömning | Antal |
| --- | ---: |
| Kompletta matrecept | 95 |
| Kompletta komponentrecept, inte fristående matrecept | 59 |
| Olösta | 52 |
| Icke-mat | 23 |
| Halal-exkluderade | 1 |
| Totalt tidigare godkända | 230 |

Det visar varför de äldre godkännandena inte får återanvändas som verifierade
resultat. **76 av 230 klarar inte längre `ready`; ytterligare 59 är komponenter.**
De 154 återstående mat-/komponentrecepten klarade data- och räkningskontrollen
för 533 ingrediensrader. Detta är ingen manuell genomgång av hela den gamla importen.

Resultat: `data/recipe-ingestion-quality/release-historical/verification.json`.

## Vad kontrollen faktiskt verifierar

Den separata verifieraren kontrollerar accepterade recept mot den lokala
katalogen och råa USDA-tabeller: produkt-ID, namn, pris, tillgänglighet,
inköpsenhet, granskade köttmärken, USDA-ID, dokumenterad portionsvikt, samtliga
nio näringsberäkningar, totalsummor, portionsdivision och filteraggregering.
Källrader och eventuell återställd ingredienssektion måste bevaras.
Filens checksumma, antal poster och statusfördelning måste stämma med rapporten.

Regressionstester matar även avsiktligt in felaktiga produkt-ID:n, massor,
näringsvärden, totalsummor, filter och rapporter. Dessa fel måste upptäckas.
Tester täcker återstart, checkpoint, karantän, fel efter halvfärdiga skrivningar,
Unicode, halalalternativ, källmotsägelser och förkontrollens stopp.

Slutliga automatiska testloggar finns i:

- `data/recipe-ingestion-quality/final-python-tests.log`
- `data/recipe-ingestion-quality/typescript-engine-tests.log`
- `data/recipe-ingestion-quality/ingredient-matcher-tests.log`

Slutresultat: **94 Python-tester och 48 TypeScript-tester godkända**; även
`npm run check` godkänd. Sammanställningen finns i
`data/recipe-ingestion-quality/recovery-summary.json` och anger uttryckligen
`bulk-not-ready-low-coverage`.

Detta är **inte** en garanti att alla recept i datasetet är semantiskt korrekta.
USDA-näringen är generiska uppskattningar, inte analys av exakt Willys-produkt.
Namnbaserade allergenfilter certifierar inte produktetiketter eller spårmärkning.
Konsistenskontrollen känner inte alla livsmedelsnamn. De begränsningarna finns
även i maskinella resultat, utan någon påstådd 100-procentig certifiering.

## Kvarvarande arbete och skydd mot en ny bortslösad körning

Täckningen är fortfarande för låg. Hindren är både verkliga dataluckor och
återstående regel-/referensluckor: saknade mängder, skadad källtext, amerikanska
produkter utan verifierad Willys-motsvarighet, livsmedelsformer som saknar
verifierad koppling eller hushållsvikt och ofullständig USDA-näring. Ett känt
produkt-ID ensamt löser inte en okänd mängd eller okänd ätbar andel.

De vanligaste hindren redovisas i verifieringsrapporten för riktat fortsatt
arbete. Kraven har inte sänkts för att få igenom fler recept. Salt efter smak
och osäkra mängder bevaras utan påhittad vikt; okända näringsbidrag blir aldrig noll.

`stream --all` utför nu förkontrollen innan huvudimporten öppnas. Kontrollen
kräver 1 000 ofiltrerade slumprecept, godkänd oberoende verifiering och tillräckligt
utbyte av kompletta matrecept. Komponenter får inte blåsa upp det utbytet.
Standardgränsen 5 % är en konfigurerbar driftspärr, ingen noggrannhetsgaranti.
`--preflight-only` kan inte starta huvudimporten, även om kontrollen godkänns.

Ändrade beräkningsregler får ny versionshash. `--resume` får inte tyst återanvända
en äldre versions checkpoint som om dess recept hade verifierats med de nya
reglerna. Tidigare engångsverktyg för enbart kraschåterställning får inte användas
för att kringgå den versionsgränsen.

**Det finns ingen rekommendation här att återuppta massimporten.**
