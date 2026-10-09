# Verifiering: Coop och ICA

Senast uppdaterad: 9 oktober 2026. Lokala regressioner och livebevis redovisas separat. ICA är uppskjutet.

| Kontroll | Resultat |
|---|---|
| `npm run check` | Passerar |
| `npm test` | 210 av 210 tester passerar |
| `npm run test:worker` | Passerar med fyra lokala databasbindings; inga fjärrresurser används |
| `npm run retailers:demo` | Passerar; noll butiks- och Cloudflare-anrop |
| `npm run retailers:init` utan molnflaggor | Returnerar lokal installationsplan; noll Cloudflare-anrop |

Tester omfattar datalagring och prisdeltan, komplett respektive avbruten insamling, dubbla kategorier, pagination, återförsök efter avbrutna svar, anropsbudget, checkpoints, aktuella dataset och granskade produktidentiteter. En oförändrad lokal publicering ändrar två metadatarader och skriver inte om produkt- eller prishistorikrader. Det verkliga [Coop-dagsjobbet 37908550399](https://github.com/addeqe/secretlol/actions/runs/37908550399) kontrollerade 376 ID:n med noll ändringar och använde 4 D1-skrivningar samt 4 034 läsningar, inklusive metadatakontroller. Coop-databasen var 1 679 360 byte. Det är ett uppmätt oförändrat fall; en ändrad katalog kostar mer.

Korgtester täcker delade produkter, blandade förpackningsstorlekar, pant, viktpris, medlems-/mängdvillkor, okända mängder, inkompatibla enheter, avrunnen vikt och tidsgränser. Extra granskning med Luna 6 hittade och rättade två numeriska gränsfall: positiva små mängder får inte försvinna, och förbrukningskostnaden avrundas först efter summering över hela korgen. Regressioner omfattar både små mängder och stora/små kombinationer i olika ordning. Genomförbar korg och bevisat billigaste korg redovisas separat när beräkningsbudgeten tar slut. API:t delar högst 20 000 arbetssteg mellan upp till tre finalister. Arbetsgränsen är inte en garanti för viss CPU-tid.

Det sparade lokala receptunderlagets sex komprimerade delar har kontrollerats mot manifestets byteantal och kontrollsummor utan molnanrop. Receptdelarna innehåller 15 244 poster och ingrediensinventeringen 96 082 förekomster av 881 unika namn. Dess hash och dataset stämmer med manifestet respektive den sparade molnstatusen. Detta ersätter inte kontroll av den aktiva molnversionen före nästa publicering.

API-tester kontrollerar att Coop/ICA-sökning filtrerar bort endast berörda recept, att godkända reserver används och att Willys-data inte används för en annan kedjas offert. Gamla Willys-anrop, behörighet, receptfilter, mängdskalning och kostnadsberäkning passerar sina tidigare kontroller. Ingen kundoffert skriver i D1. Delad priscache använder ett gruppdokument i stället för ett anrop per produkt; ett test med 400 priser använder en cachelagring och en kall cacheläsning.

Publiceringen sparar en versionsbunden statussammanfattning atomärt med priser och aktiv körning. Kalla receptanrop behöver därför inte läsa eller validera alla 881 kopplingar och 376 produkter. Begärda kopplingar valideras fortfarande mot sina valda produkter. Tester täcker fel version, fel sammanfattning, saknad vald koppling, äldre körningar utan sammanfattning samt omräkning när ett framtida pris börjar gälla.

Korgens produktuppslag använder ett index per ID; identitets- och policykontroller återanvänds med innehållskontroll och begränsade cacher. Mutation av namn, varumärke, kategori, förpackning eller ingredienslista bryter cachen. Konflikter mellan observationer med samma ID förblir spärrade. Ett litet rent policyanrop under modulstart förbereder V8:s uppskjutna regexkompilering utan nätåtkomst eller databasändring.

Efter sista driftsättningen (`8f51d05c-64ee-4098-a6e3-9321b6709fc5`) omfattar det sparade Cloudflare-provet åtta lyckade anrop utan rapporterade fel. De separerade, upprepade referens-/lokalofferterna motsvarar CPU-grupper på 4,910 respektive 5,486 ms; ett nytt uppslag i en andra prisbutik gav 7,605 ms. Första receptanropet och första lokala offerten gav 14,450 respektive 18,805 ms. Kopplingen till anropen bygger på avgränsade tidsfönster; analysen har ingen endpoint-dimension och är adaptivt samplad. Detta är inte ett lastprov eller en garanti för maximala menyer.

Workers Free anger 10 ms CPU per anrop och viss tolerans för enstaka överskridanden. Molnproven passerade, men konsekvent drift under gränsen för alla kalla eller maximala anrop är **inte verifierad**. Hög trafik kräver fortsatt mätning och kan kräva mer uppdelad beräkning. Ingen betald plan har aktiverats. Se [Cloudflares CPU- och startgränser](https://developers.cloudflare.com/workers/platform/limits/).

Coops automatiska källa har nu verifierats lokalt med riktiga anrop för pickupbutik `035000`: kategoriträd, tre produktuppslag och två separata sidor med 24 Skafferi-produkter vardera, genom fyra paced anrop utan återförsök. Kategorin rapporterade 1 836 produkter; provet kontrollerade bara dessa två sidor. Parsergranskningen rättade att förpackningspris kunde få jämförprisets kg-/literenhet. Regressionen genom parser och korgberäkning bekräftar att 640 g tortilla och 250 g smör kräver två respektive ett paket, 8 940 öre i inköp och 5 965 öre i förbrukning. Testerna omfattar också offentligt erbjudande, medlems-/mängderbjudande, riktig viktvara, pant, ofullständiga svar och verkliga navigationsposter.

Butikssökningen behåller nu både Coops fysiska pickup-punkts-ID och fulfilment-butikens pris-ID när de skiljer sig åt, till exempel ett skåp som tillhör en annan prisbutik. Offerten använder fulfilment-butikens onlinepris för pickup; den visar inte hyllpriset på den fysiska pickup-platsen.

ICA:s butikssökning och butiksspecifika kategoriträd fungerar från servern. Produktanropen får CloudFront 403 trots korrekt butiksadress och anropsformat. Den normala webbappen visar priser genom sin AWS WAF-integration; någon reproducerbar automatisk produkt-/priskälla för GitHub/Worker har inte verifierats. ICA:s prisadapter hålls avstängd. Se [källunderlaget](upstream-ica.md) och [återstående molnkälla](ica-browser-bridge.md).

Coops fulla startscan, Luna-granskning, separata D1-databas, produktimport och Worker-driftsättning har körts den 9 oktober. GitHub Actions-källprovet [37904883640](https://github.com/addeqe/secretlol/actions/runs/37904883640) passerade. Moln-API:t har verifierats med referensoffert, lokal offert för samma butik samt två menyfinalister hos Coop Daglivs. Samma verifierade gräddprodukt gav 2 550 öre i Västberga och 2 755 öre i Daglivs; offerterna använde respektive prisbutik. Alla fem receptdelar är verifierade och det tillfälliga importjobbet har stängts av.

Ett större molnprov gav komplett referensoffert för recept 25493 med elva ingredienser, 22 288 öre i inköp. En lokal offert för Daglivs gav 23 163 öre för samma recept och 28 162 öre för alternativet 71854; båda var kompletta och optimeringen avslutades. Beloppen är observationer från den 9 oktober, inte fasta priser.

Coops källobservationer gäller i högst 24 timmar eller till valt erbjudandes slut. Den lokala kundcachen begränsar samma observation till 30 minuter. Regressioner täcker referenspris efter sex timmar, ett erbjudande som slutar efter 20 minuter och lokal cache som löper ut efter 30 minuter.

Ett separat, avgränsat ICA-browserprov i `scripts/probe-ica-browser.mjs` har körts efter användarens uttryckliga godkännande. Vanlig Chromium öppnade butikssidan och följde dess kakdialog/kategorimeny. Den sista produktkontrollen upptäckte CAPTCHA och stoppades utan lösning eller ytterligare liveförsök. Ingen komplett produkt-/prisartefakt skapades. Automatisk ICA-prishämtning förblir avstängd. Syntaxkontrollen passerar och standardkörningen stoppar fortfarande före browserimport och nätåtkomst.

Full sourcevidens, kategoriträd och kontrollsummor finns i [Coop-releasen](https://github.com/addeqe/secretlol/releases/tag/coop-reference-2026-10-09). Startscannen har 14 368 unika produkter, 748 lövkategorier och 1 121 sidor; alla kategoriantal stämde. Den är en sekventiell observation, inte en atomär upstream-snapshot. Matchningsbeslut valideras mot hela inventeringen, kataloghash, namngivna produkter och aktuell policy. En slutgranskning rättade ett basmatiris som var blandat med vanligt långkornigt ris; rena basmatiprodukter används i stället.
