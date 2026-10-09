# Plan: Coop och ICA för matplaneraren

Datum: 8 oktober 2026. Godkänd plan med byggd och lokalt testad infrastruktur. Lokal jämförelse av flera menyförslag och optimering av hela inköpskorgen ingår. Fullständiga scans, molnimporter och driftsättning väntar på kvotåterställning och verifierade butikskällor. Aktuell avprickning finns i [checklistan](coop-ica-todo.md).

## Målet

En stor referensbutik per kedja ger ett grundsortiment och ungefärliga kedjepriser för receptval. Kundens valda butik ger sedan lokala produktval och priser för just de ingredienser som behövs. Daglig insamling för Coop och ICA begränsas till produkterna som används i godkända kopplingar och deras reserver.

Willys, Coop och ICA får varsin produktdatabas. Recept, ingrediensmängder och klassificeringar fortsätter ligga i den gemensamma receptdatabasen. Matplaneraren använder ett gemensamt moln-API.

```text
Coop referensbutik → första fullständiga scan → ingredienskopplingar → coop-catalog
ICA referensbutik  → första fullständiga scan → ingredienskopplingar → ica-catalog
Willys befintliga insamling och kopplingar                       → willys-catalog
Recept, mängder, allergier, kost och kategorier                  → mealplanner-recipes
                                  ↓
                         Gemensamt moln-API
                                  ↓
             Högst tre menyförslag med referenspriser per vald kedja
                                  ↓
       Postnummer → möjliga butiker → kundens butik och handelsform
                                  ↓
   Hämta unionen av behövda lokala produkter för menyförslagen
                                  ↓
    Optimera hela förpackningar → jämför lokala korgar → välj meny
```

## 1. Verifiera datakällorna innan hela insamlingen

En Luna 6-agent ansvarar för Coop och en för ICA. En tredje granskar resultat, identifierare och prisberäkning. Små kontroller görs först, utan hela butiksscans.

Kontroller för varje kedja:

- Kategoriträd och kategori/browse-listning utan sökord; alla sidor kan hämtas med ett tydligt slutvillkor.
- Butiksval, produkternas butikstillhörighet och skillnaden mellan hämtning och hemleverans.
- Produktuppslag på ID, eventuell hämtning av flera ID:n i samma anrop och EAN när detta finns.
- Ordinarie pris, offentligt kampanjpris, medlemspris, mängderbjudande, pant, viktpris och giltighetsdatum kan hållas isär.
- Produktnamn, varumärke, storlek, innehåll och tillgänglighet finns i tillräcklig omfattning för granskning och kostnadsberäkning.
- Samma produkt kontrolleras i minst två butiker. Vi verifierar om kedjans ID kan återanvändas eller måste översättas till ett lokalt butiks-ID.
- Anrop fungerar även från GitHub Actions respektive den molnbackend som ska göra lokala prisuppslag. Ett lyckat anrop från en dator är inte tillräckligt.

**Läget efter källarbetet 8 oktober:** Coop har verifierad butikssökning för hämtning, kategoriträd, kategoribrowse utan sökord och produkt-/batchuppslag med butiksspecifika onlinepriser. Prisadaptern stöder hämtning utan leveranstid. Ett generiskt EAN-uppslag används aldrig som lokalt pris. ICA:s postnummeruppslag och butiksspecifika kategoriträd fungerar automatiskt. Produkter och priser visas i en vanlig anonym webbläsare, men serverns produktanrop får CloudFront 403; webbappen använder `AwsWafIntegration.fetch`. ICA:s produkt-/prisadapter förblir avstängd tills en fungerande körväg har verifierats. Produkt-ID:s portabilitet, fullständigt sortiment och drift från GitHub/Worker återstår för båda kedjorna. Detaljer finns i [Coop-underlaget](upstream-coop.md) och [ICA-underlaget](upstream-ica.md).

X:-tra-butiker undersöks separat. Produktmärket Xtra i Coops webbshop bevisar inte att X:-tra-butikernas sortiment och priser finns i samma API. En butik utan verifierad onlinekälla markeras som ej stödd.

**Leverans:** dokumenterade anrop, små sparade testsvar och ett resultat per kontroll. Ingen kedja räknas som klar för full scan förrän butiksspecifik enumeration och prishämtning fungerar.

## 2. Välj referensbutiker

Vi söker stora Stora Coop- och ICA Maxi-nätbutiker och jämför tillgängliga sortimentsantal för kandidater där det går. Referensbutiken ska ha ett dokumenterat stort online-sortiment, stabil produktåtkomst och många av våra relevanta ingredienser. Störst fysisk butik betyder inte automatiskt flest onlineprodukter.

Om vi inte kan verifiera vilken butik som är störst i hela kedjan beskriver vi urvalet som den största verifierade kandidaten. Namn, storeId, handelsform och urvalsunderlag sparas. Ett generiskt lagersortiment används inte som om det vore en kunds lokala butik.

## 3. Gör en fullständig startscan per vald butik

- Gå igenom alla relevanta matkategorier och alla sidor. Spara även produkter som just nu är slut om källan listar dem.
- Ta bort dubbletter när en produkt tillhör flera kategorier.
- Kontrollera slut på pagination, rapporterade antal där sådana finns, att ingen sida tappats och att anrop behåller rätt butikskontext.
- Spara produkt-ID, eventuellt EAN, varumärke, storlek, enheter, innehåll, prisvillkor, tillgänglighet och källuppgifter.
- Använd begränsad anropstakt, återförsök med väntetid och checkpoints för återupptagning.

Startscannen sparas som ett komprimerat underlag i GitHub/ett molnarkiv, med datum och kontrollsumma. Den behöver inte läsas av kundappen. Efter matchning publiceras de använda produkterna och godkända reserverna i respektive aktiva D1-databas; det minskar första importens och framtida uppdateringars förbrukning. Det kompletta startunderlaget behålls för granskning och nya kopplingar.

Fullständighet avser det sortiment som den valda nätbutiken publicerar vid insamlingen. En enda butik kan inte garantera tillgång till alla produkter som säljs någonstans i kedjan.

## 4. Koppla våra befintliga ingredienser till båda kedjorna

Ingredienslistan läses från molnets godkända receptsamling. Den nuvarande releasen innehåller 881 unika ingrediensnamn och 15 244 recept. Äldre bortsorterade recept eller ingredienser tas inte in igen.

Arbetet sker i tre steg:

1. Befintliga normaliseringar, matidentiteter, svenska synonymer och regelbaserad kandidatfiltrering ger en kort produktlista per ingrediens och kedja.
2. Luna 6-agenter granskar kandidater i små grupper, normalt 15–25 ingredienser. Grupperna delas efter mattyp. Antalet samtidiga agenter följer miljöns gräns; i denna miljö kan upp till tre underagenter arbeta samtidigt medan huvudagenten samordnar.
3. Automatisk kontroll validerar varje beslut mot den hämtade produkten. En annan agent granskar tvetydiga och känsliga beslut. Alla köttkopplingar, specialkostprodukter och beslut med låg säkerhet får extra kontroll; enkla beslut kontrolleras även genom slumpmässiga stickprov.

Beslutet innehåller ingrediens, kedja, referensbutik, produkt-ID, EAN där tillgängligt, produktform, förpackning, motivering, policyversion och granskare. En huvudsaklig produkt och upp till två kompatibla reserver sparas när sådana finns. Pris jämförs i relevant enhet och under rätt köpvillkor, inte bara efter lägsta paketpris.

Samma befintliga regler för förbjudna ingredienser och godkända köttvarumärken gäller för Coop och ICA. Ingen godkänd köttprodukt innebär att kopplingen saknas för den kedjan. Ett annat varumärke ersätter inte automatiskt den godkända produkten. Produktinnehåll används där det finns för att kontrollera särskilda krav; okänd information får inte förvandlas till ett säkert allergi- eller kostbesked.

**Leverans:** antal matched, needs_review, unavailable och non_purchased per kedja, granskade produktkopplingar och antal kompletta/prissättningsbara recept. Recept kan vara tillgängliga hos en kedja och saknas hos en annan; detta ändrar inte den gemensamma receptsamlingen.

## 5. Databaser och identiteter

| Databas | Innehåll |
|---|---|
| willys-catalog | Befintliga Willys-produkter, priser och kopplingar |
| coop-catalog | Coop-referensbutik, använda produkter/reserver, kopplingar och lokala uppslag som faktiskt behövts |
| ica-catalog | ICA-referensbutik, använda produkter/reserver, kopplingar och lokala uppslag som faktiskt behövts |
| mealplanner-recipes | Gemensamma recept, mängder, näring, recensioner och filter |

Förberedda tabeller i varje ny kedjedatabas:

- `retail_stores`: verifierade butik-ID:n och butiksuppgifter.
- `retail_products`: kompakt produktidentitet, prisvillkor och tillgänglighet för produkter som används.
- `retail_connections`: granskad huvudprodukt, högst två reserver och beslutsunderlag.
- `retail_tracked`: unik mängd godkända produkt-ID:n att kontrollera dagligen.
- `retail_meta`, `retail_runs` och `retail_scope_state`: dataset/policy/version, kontrollerad produktmängd, tidsstämplar och aktiv körning.
- `retail_local_mappings`: verifierad översättning av samma förpackade vara till ett annat lokalt produkt-ID. Ny produktform eller ändrat innehåll kräver ny granskning.
- `retail_price_history`: bara ändrade priser och prisvillkor, med begränsad städning av historik.
- `retail_connection_health`: senaste status för godkänd huvudprodukt/reserv och vilka identitetsändringar som behöver granskas.

Lokala prisuppslag använder en kort cache i Worker och skriver inga offert- eller prisrader i D1 per kundanrop. En bredare beständig lokal priscache införs endast om mätningar visar att den behövs.

Nycklar skiljer kedja, butik, produkt, variant/förpackning och handelsform. EAN är en hjälp för samma förpackade vara; viktvaror, saknade EAN och andra förpackningar hanteras genom verifierad produktidentitet. Ett ICA-ID får inte tolkas som ett Coop- eller Willys-ID. Tillgänglighet och pris hör till denna butikskontext, inklusive leveranstid/slot om källan använder detta, inte till produkten globalt.

## 6. Daglig uppdatering av bara använda produkter

GitHub Actions kör Coop och ICA dagligen tillsammans med det befintliga upplägget. Insamlarna är separata så ett fel hos en kedja inte stoppar de andra. Cloudflare serverar API:t och databaserna; långa insamlingar görs i GitHub Actions.

Varje kedja hämtar unionen av huvudprodukter och godkända reserver, med dubbletter borttagna. Produkter som inte längre används behöver inte hämtas dagligen. Där API:t stöder det används uppslag av flera produkt-ID:n samtidigt.

Vi jämför innehållshash mot föregående version och skriver bara verkliga ändringar i pris, erbjudande, tillgänglighet, storlek, varumärke eller annan relevant information. Oförändrade kontrollerade produkter får aktualitet genom körningsmetadata för exakt den kontrollerade produktmängden. Logiska `last_checked_at`, `observed_at` och `expires_at` följer varje produkt, butik och handelsform; de kan lagras i en kontrollerad grupps metadata för att slippa omskrivning av alla produktposter. Bara lyckade uppslag får en ny kontrolltid. Den nuvarande Willys-modellen som stämplar hela snapshoten får inte användas för okontrollerade Coop-/ICA-produkter.

När priser ändras jämförs de kända kompatibla alternativen igen; bara berörda kopplingar behöver räknas om. Om huvudprodukten försvinner eller blir otillgänglig prövas en godkänd reserv. Saknas reserv görs en begränsad sökning/kategorihämtning för den berörda ingrediensen, följd av samma validering. Svåra nya kandidater hamnar i en granskningskö för nästa agentgranskning; dagsjobbet behöver inget betalt AI-API. Tillfälligt nätfel eller ett trasigt API betyder inte att produkten har utgått.

Den första fullständiga scannen upprepas inte som daglig rutin. Enbart uppslag av kända ID:n upptäcker inte alla nya billigare produkter. Förslaget prioriterar därför bästa godkända alternativ bland de kända produkterna, och söker nya alternativ när en koppling behöver repareras. En framtida återkommande kontroll av nya varor skulle vara en separat utökning.

Den nuvarande Willys-matcharen kräver att hela dess katalog är färsk. Coop/ICA får ett uttryckligt läge där aktualitet bedöms för den spårade produktmängden och lokalt för efterfrågade produkter, så att äldre arkivprodukter inte stoppar uppdateringarna.

## 7. Postnummer och lokal offert

1. Kunden anger postnummer. Vi använder kedjans verifierade butikslokator och föreslår stödda butiker. Kunden kan välja butik och hämtning/hemleverans; postnummer ensamt identifierar inte en entydig butik.
2. Matplaneraren bygger ett litet antal bra menyförslag med referenspriserna, normalt två och högst tre. Detta är den godkända förbättringen **lokal jämförelse före slutligt menyval**. Vi hämtar inga lokala priser för hela receptdatabasen.
3. Vi slår upp unionen av menyförslagens godkända produkter och reserver i kundens butik, med dubbletter borttagna. En vara som används i flera förslag hämtas en gång och återanvänds i jämförelsen.
4. Först prövas samma produkt genom ett verifierat ID eller EAN. Om den saknas prövas kompatibla reserver eller en riktad ingredienssökning. Lokal ersättning måste följa form, mängd, verifierade produktkrav och köttpolicy. Saknat ingrediens-/allergenunderlag bevisar inte allergenfrihet; receptets klassificering är inte heller ett bevis för en ersättningsprodukts innehåll.
5. Detta är den andra godkända förbättringen: **optimera kostnaden för hela inköpskorgen**. Mängder för alla recept i en meny summeras först. Vi jämför kombinationer av godkända förpackningar, kan blanda paketstorlekar och delar samma paket mellan kompatibla ingrediensrader. Pant ingår i inköpskostnaden. Lägst jämförpris per kilo behöver inte ge billigast korg.
6. Menyförslagen rangordnas efter sin faktiska lokala inköpskostnad och kontrolleras mot budget. Kunden får butik, inköpslista, förbrukningskostnad, hela paket, kvarvarande mängd och prisernas giltighet. En ofullständig offert får inget påhittat totalpris.

Exempel på förpackningsval: behov 750 g, ett godkänt paket 500 g för 20 kr och ett 250 g för 11 kr. Kombinationen kostar 31 kr; enbart 500 g-paket skulle kräva två paket för 40 kr. Enbart 250 g-paket skulle kosta 33 kr. Alternativen måste avse kompatibla, granskade varor.

Sökningen efter bästa korg delas upp i oberoende ingrediensgrupper och har en tydlig beräkningsgräns. Ett giltigt pris för en genomförbar korg kan finnas även om det inte gått att bevisa det absolut billigaste valet inom gränsen. API:t skiljer då `complete` från `optimizationComplete`; det påstår inte att ett obevisat resultat är optimalt.

Exempel: ett recept rangordnas med uppskattningen 42 kr från ICA-referensbutiken. De behövda lokala produkterna ger 47 kr. Kunden visas 47 kr med butik och prisunderlag; budgetkontrollen använder därefter 47 kr.

Förbrukningskostnad och kostnad för hela förpackningar hålls isär. Kvalitativa mängder, saknad styckvikt eller densitet får fortfarande okänd kostnad. Medlemspriser och flerköp används bara när rätt villkor gäller. Lokala webbshopspriser betecknas som sådana; de intygar inte alla fysiska hyllpriser eller ett framtida kassabelopp. Viktvaror kan få ett slutligt belopp först vid vägning.

## 8. Gemensamt API och låga reads/writes

Planerade tillägg till befintligt API:

| Anrop | Funktion |
|---|---|
| `GET /retailers` | Kedjor, referensbutiker, stödda funktioner och aktualitet |
| `GET /stores?retailer=ica&postalCode=...` | Stödda butiker för postnummer och handelsform |
| `GET /meal/recipes?retailer=coop&...` | Recept/filter med kedjans referenskopplingar och uppskattade priser |
| `POST /meal/quote` | Referensoffert eller lokal offert med retailer, storeId, handelsform och receptval |
| `GET /retailers/openapi.json` | Dokumentation av kedjeutökningen |

Gamla anrop fortsätter använda Willys som standard. Nya svar har generella `retailer`, `productId`, `storeId`, prisgrund, versioner och tidsstämplar. Befintliga Willys-fält behålls för nuvarande klienter. Appens backend använder API:t; kedjesessioner och privata tokens publiceras inte i frontend.

Optimering:

- Exakta indexerade uppslag och batchläsning för efterfrågade ingredienser/produkter.
- Statiska recept och granskade produktidentiteter återanvänds mellan användare.
- Lokala priser återanvänds i Cloudflare Worker Cache API med en kort cachetid, preliminärt 30 minuter och aldrig förbi ett känt erbjudandes slut. Cache-nyckeln omfattar kedja, butik, produkt/variant, handelsform, eventuell leveranstid/slot och prisvillkor. Cache delas vid tillgänglig cacheplats men är inte en garanterat global cache; kalla instanser och olika datacenter kan behöva nya uppslag.
- Butikslistor och identitetsöversättningar kan ha längre cachetid än priser, med kontroll vid förändringar.
- Lokala observationer sparas begränsat, endast vid behov/ändring. Ett användaranrop ska inte skriva en ny receptoffert eller en ny komplett prislista i D1. Vid cachemiss hämtas produkten från kedjan och svaret får kontrolltid i cache. D1:s prisdokument uppdateras bara när innehållet faktiskt ändrats eller en ny produkt/butik observerats; deduplicering och villkorad uppdatering hindrar identiska kundanrop från att skapa nya historikrader. En oförändrad cachekontroll gör inte ett äldre beständigt observationsdatum färskt efter att cache har försvunnit.
- Cachemissar och parallella anrop begränsas; stora produktmängder delas i hanterbara omgångar. Vi verifierar det faktiska antalet externa anrop innan vi väljer batchstorlek.
- Gamla lokala observationer och överflödig historik städas i små budgeterade omgångar.
- Pris- och kopplingsändringar behöver inte skriva om receptdokumenten.

Cloudflare Free ger 5 miljoner lästa och 100 000 skrivna D1-rader per dag för kontot; separata databaser ger inte en ny dagskvot. Free tillåter 10 D1-databaser och 500 MB per databas. Planen använder fyra databaser inklusive de befintliga, men kontots övriga databaser och förbrukning kontrolleras före installation. Indexunderhåll, raderingar och cachelagring räknas också in. Gränser för externa anrop och övriga tjänster mäts separat.

Första importerna etappindelas vid behov och delar förbrukningsbudget med Willys och den pågående receptimporten. Resultat redovisas för en startscan, en oförändrad dag, en dag med ändringar och lokala offerter med kall/varm cache. Exakta besparingar och responstider utlovas först efter mätning. Drift är avgiftsfri så länge de samlade gratisgränserna räcker; inga betalda API:er eller AI-anrop krävs i den vanliga kund- eller dagsdriften.

## 9. Kontroll före driftsättning

- Två butiker per kedja: samma EAN/produkt, annan förpackning och saknad vara hanteras rätt.
- Matchningskontroll omfattar samtliga känsliga beslut, tvetydiga kopplingar och slumpmässiga stickprov på enkla kopplingar. Fel och kontrollomfång redovisas.
- Referens- och lokala offerter kontrolleras mot butikens publicerade produktuppgifter för enkla och blandade recept samt en veckoplan.
- Tester för kg/st, gram/ml/styck, förpackningsavrundning, pant, medlemsvillkor, kampanjexpiry och okänd mängd.
- Förbjuden köttprodukt får aldrig användas som lokal ersättning.
- Kedjespecifik recepttillgänglighet kan inte radera eller göra ett recept otillgängligt hos övriga kedjor.
- Felaktig, tom eller avbruten insamling ersätter inte en fungerande aktiv version. För gamla eller saknade lokala prisuppgifter blir tydligt ofullständiga offerter.
- Befintliga Willys-anrop och kostnadsberäkningar fortsätter fungera.
- API-responstid och Cloudflare-förbrukning mäts under verkliga små testfall; mätningarna styr cachetid, batchstorlek och budget.

## 10. Genomförande efter godkännande

Ordning: bygg och testa schema/lagring, granskning, korgberäkning, API, cache och inaktiva dagsjobb lokalt → slutför verifiering av butikskällor → kontrollera återställd gemensam molnkvot → välj referensbutiker → fullständiga startscans → Luna-granskade kopplingar → skapa nya kedjedatabaser och publicera delta → små driftprov → driftsättning och aktivering av dagliga uppslag.

Coop- och ICA-arbetet kan gå parallellt i separata filer/moduler. Gemensamma schema- och API-ändringar samordnas för att undvika konflikter. Luna 6 används för kedjeadaptrar, kandidatgranskning och avgränsade kontroller, medan huvudagenten ansvarar för integration och slutlig verifiering. De dagliga jobben använder regler och tidigare granskade beslut; de startar inte nya AI-granskningar rutinmässigt.

Rapporten efter genomförandet visar referensbutiker, fulla startantal, aktiva produktantal, kopplingsstatus per kedja, recepttäckning, prisaktualitet, lokala offertresultat och uppmätta reads/writes. Bristande täckning redovisas öppet i stället för att fyllas med fel produkter.

## Källor och befintligt underlag

- [Coop webbshop](https://www.coop.se/handla/) och [Coops sortimentsbeskrivning](https://kundservice.coop.se/hc/sv/articles/360009495240-Sortimentet-Coop-se).
- [X:-tra](https://www.x-tra.se/) och [Coops butiksformat](https://www.coop.se/Globala-sidor/om-coop/Vara-format/).
- [ICA Handla](https://handla.ica.se/), [ICA:s butiksspecifika webbshop](https://handlaprivatkund.ica.se/) och [ICA:s butikslokator](https://handla.ica.se/api/store/v1?zip=11455&customerType=B2C).
- [ICA:s information om butikernas online-sortiment](https://www.icagruppen.se/leverantorer/ica-online/) och [köpvillkor för priser, pant och viktvaror](https://www.ica.se/handlaonline-kopvillkor/).
- [Cloudflare D1-priser](https://developers.cloudflare.com/d1/platform/pricing/), [D1-gränser](https://developers.cloudflare.com/d1/platform/limits/) och [Workers-gränser](https://developers.cloudflare.com/workers/platform/limits/).
- Befintligt lokalt underlag: `docs/mealplanner-api.md`, `docs/verification.md`, `src/dietary-policy.ts`, `src/ingredient-publish.ts`, `worker/meals.ts` och `src/catalog-storage.ts`.
